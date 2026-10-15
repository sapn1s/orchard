#!/usr/bin/env node
/**
 * Ask subject gate: an `orchard-ask` about the agent's OWN call is refused at turn end.
 *
 *   node scripts/verify-ask-subject-gate.mjs
 *   ASKGATE_ROOT=<tree> node scripts/verify-ask-subject-gate.mjs   # run against another tree (must-FAIL)
 *
 * BUG-256 made the `decider:` line an exact closed-list code plus a `consequence:`.
 * That validates WHY a call is the user's, never WHAT is being decided, so an ask
 * about sequencing, implementation, another round, the next step or a go-ahead on
 * the agent's own recommendation passed under any well-formed code. Session
 * 20ed61fc (2026-10-13) idled ~420 min overnight on one: "I recommend one more
 * round, with a structural fix" (declared `decider: spend`).
 *
 * The fix classifies STRUCTURALLY — the declared `about:` subject × the decider —
 * with no phrase list. This suite drives the REAL hook binary:
 *   [1] the three 20ed61fc asks, written to the current spec (a valid decider code
 *       and consequence, the honest subject) → BLOCKED as agent-owned. Pre-fix they PASS.
 *   [2] legitimate asks (restart, a click only the user can make, account-quota
 *       spend, a direction fork, taste, a fact, push / irreversible approvals) → ALLOWED.
 *   [3] the subject grammar: missing / off-list / compound `about:` → BLOCKED once;
 *       case and padding fold.
 *   [4] agent-owned is reported before a label defect (so the fix is "decide", not "relabel").
 *   [5] telemetry records the subject and the refusal.
 * No mocks; throwaway transcripts and data dir.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(process.env.ASKGATE_ROOT || path.join(import.meta.dirname, '..'));
// An onboarded project carries the flat `.orchard/` copy (hooks/ + lib/); test that when present.
const FLAT = fs.existsSync(path.join(ROOT, '.orchard', 'hooks', 'response-format-gate.mjs'));
const HOOK = FLAT ? path.join(ROOT, '.orchard', 'hooks', 'response-format-gate.mjs') : path.join(ROOT, 'scripts', 'hooks', 'response-format-gate.mjs');
const fm = await import(pathToFileURL(FLAT ? path.join(ROOT, '.orchard', 'lib', 'format-metrics.mjs') : path.join(ROOT, 'scripts', 'lib', 'format-metrics.mjs')).href);
console.log(`hook under test: ${HOOK}`);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'askgate-data-'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'askgate-tx-'));

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${observed}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}

const DIGEST = '```orchard-digest\n{ "items": [ { "text": "x.", "kind": "decision", "importance": "high" } ] }\n```';
let n = 0;
function runHook(askBody) {
  const p = path.join(TMP, `t${n++}.jsonl`);
  const text = `${DIGEST}\n\n\`\`\`\`orchard-ask\n${askBody}\n\`\`\`\``;
  fs.writeFileSync(p, JSON.stringify({
    type: 'assistant', isSidechain: false,
    message: { id: `msg_${n}`, role: 'assistant', content: [{ type: 'text', text }] },
  }) + '\n');
  const sid = `askgate-${n}`;
  const payload = JSON.stringify({
    session_id: sid, cwd: '/tmp', transcript_path: p, hook_event_name: 'Stop',
    stop_hook_active: false, last_assistant_message: text,
  });
  let out = '';
  try {
    out = execFileSync('node', [HOOK], {
      input: payload, encoding: 'utf8',
      env: { ...process.env, ORCHARD_SESSION: sid, CLAUDE_STATION_DATA: DATA },
    });
  } catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
  return { blocked: /"decision":"block"/.test(out), agentOwned: /are YOUR call, not the user's/.test(out), out };
}
const tag = (s) => s.split('\n').filter((l) => /^(about|decider):/i.test(l)).join(' | ');

// ── [1] the 20ed61fc asks (bodies verbatim; header lines as a compliant agent writes them now)
const ASKS_20ED = [
  ['15:47 "Shall I file it and start the fix?"',
    'I recommend fixing this. The account picker should show the account the server actually tied the session to.\n'
    + 'Shall I file it and start the fix?\nconfidence: high\nabout: approval\ndecider: direction\n'
    + 'consequence: the picker keeps showing the wrong account until it is fixed'],
  ['17:04 "Shall I measure it before you decide?"',
    'Should this become the default for every ticket: ship once it\'s built, verify afterwards?\n'
    + 'I\'d first measure how much of a typical lane\'s time goes to building versus verifying.\n'
    + 'Shall I measure it before you decide?\nconfidence: low\nabout: next-step\ndecider: info\n'
    + 'consequence: the default stays as it is until the measurement lands'],
  ['23:20 "I recommend one more round" (the ~420-min stall)',
    'I recommend one more round, with a structural fix.\n'
    + '- A single function decides which account a launch will use.\n'
    + 'Expect another long round: about an hour to build, plus a check.\nconfidence: med\nabout: round\ndecider: direction\n'
    + 'consequence: shipping now leaves two edge cases showing the wrong account'],
];
console.log('[1] the 20ed61fc agent-owned asks are refused');
for (const [label, body] of ASKS_20ED) {
  const r = runHook(body);
  check(`${label} → blocked as agent-owned`, r.blocked && r.agentOwned, `${tag(body)} → blocked=${r.blocked} agentOwned=${r.agentOwned}`);
}
// The same shapes under the other subjects an agent might pick for its own work.
// Every agent-owned subject under every non-action stop (taste, direction, info, blocked) is refused.
for (const s of ['sequencing', 'implementation', 'round', 'next-step', 'approval']) {
  for (const d of ['taste', 'direction', 'info', 'blocked']) {
    const body = `I recommend doing BUG-207 before FEAT-181.\nconfidence: med\nabout: ${s}\ndecider: ${d}\nconsequence: the other ticket waits about an hour longer`;
    const r = runHook(body);
    check(`about: ${s} under decider ${d} → blocked`, r.blocked && r.agentOwned, `${tag(body)} → blocked=${r.blocked}`);
  }
}

// ── [2] legitimate asks pass
const LEGIT = [
  ['restart (20ed61fc 17:07)', 'Restart the service whenever it suits you: `systemctl --user restart claude-station`.\nconfidence: high\nabout: action\ndecider: live\nconsequence: the restart interrupts every running session, this one included'],
  ['Needs-You click (20ed61fc 20:49)', 'Click "Adopt A" on FEAT-182 in the Needs-You rail. Only your click reaches the answer route.\nconfidence: high\nabout: action\ndecider: blocked\nconsequence: the decision stays open until you click it'],
  ['account-quota spend (20ed61fc 09:02)', 'I recommend holding the 13 implied builds until the weekly quota resets.\nconfidence: med\nabout: spend\ndecider: money\nconsequence: running them now would likely use up the weekly quota for the rest of the week'],
  ['direction fork', 'I recommend A: ship the board as a separate package. B keeps it inside Orchard.\nconfidence: med\nabout: goal\ndecider: direction\nconsequence: A commits us to maintaining a public package'],
  ['taste', 'I recommend the dark sidebar; the light one washes out the status dots.\nconfidence: med\nabout: preference\ndecider: taste\nconsequence: you will look at this sidebar every day'],
  ['fact only the user has', 'Which account did you pick when the wrong one showed?\nconfidence: low\nabout: fact\ndecider: info\nconsequence: without it I cannot tell which launch path lied'],
  ['approval of an outward recommendation', 'I recommend pushing main to GitHub now.\nconfidence: high\nabout: approval\ndecider: outward\nconsequence: the commits become public on the remote'],
  ['approval of an irreversible recommendation', 'I recommend deleting the 2 GB of old transcripts.\nconfidence: med\nabout: approval\ndecider: irreversible\nconsequence: the deleted transcripts cannot be recovered'],
  ['a round that spends account quota (money exemption)', 'I recommend one more OpenAI round.\nconfidence: med\nabout: round\ndecider: money\nconsequence: the round uses about 20% of your weekly OpenAI quota'],
  ['approval to touch the user\'s other repo (access)', 'I recommend adding a package.json to trading_volume; it is your own project.\nconfidence: med\nabout: approval\ndecider: access\nconsequence: I would be editing a repository you own outside this one'],
  ['approval to commit now (git)', 'I recommend committing now; a second check is optional.\nconfidence: high\nabout: approval\ndecider: git\nconsequence: the verified fix stays uncommitted until you commit it'],
  ['git write the user holds','Commit these 6 files when ready: scripts/lib/format-metrics.mjs …\nconfidence: high\nabout: action\ndecider: git\nconsequence: the fix stays uncommitted until you commit it'],
];
console.log('[2] legitimate asks pass');
for (const [label, body] of LEGIT) {
  const r = runHook(body);
  check(`${label} → allowed`, !r.blocked, `${tag(body)} → blocked=${r.blocked}`);
}

// ── [3] subject grammar
console.log('[3] the about: grammar is exact');
const GRAMMAR_BLOCK = [
  ['no about: line', 'I recommend the dark sidebar.\nconfidence: med\ndecider: taste\nconsequence: you will see it every day'],
  ['off-list subject', 'I recommend the dark sidebar.\nconfidence: med\nabout: ui\ndecider: taste\nconsequence: you will see it every day'],
  ['compound subject goal/round', 'I recommend one more round.\nconfidence: med\nabout: goal/round\ndecider: direction\nconsequence: shipping now leaves an edge case'],
  ['subject with trailing words', 'I recommend one more round.\nconfidence: med\nabout: goal (another round)\ndecider: direction\nconsequence: shipping now leaves an edge case'],
];
for (const [label, body] of GRAMMAR_BLOCK) {
  const r = runHook(body);
  check(`${label} → blocked`, r.blocked, `${tag(body)} → blocked=${r.blocked}`);
}
{
  const body = 'I recommend the dark sidebar.\nconfidence: med\nAbout:   PREFERENCE  \ndecider: taste\nconsequence: you will see it every day';
  const r = runHook(body);
  check('case and padding fold (About:   PREFERENCE) → allowed', !r.blocked, `blocked=${r.blocked}`);
}

// ── [4] precedence, pure helper
console.log('[4] agent-owned is reported before a label defect');
{
  const parsed = { blocks: [{ name: 'orchard-ask', content: 'I recommend one more round.\nconfidence: med\nabout: round\ndecider: priority' }] };
  const d = typeof fm.askOwnershipDefects === 'function' ? fm.askOwnershipDefects(parsed) : [];
  check('about: round + decider: priority → ask-agent-owned (not decider-not-hard-stop)',
    d.length === 1 && d[0].defect === 'ask-agent-owned', JSON.stringify(d));
  const ok = { blocks: [{ name: 'orchard-ask', content: 'Restart when ready.\nconfidence: high\nabout: action\ndecider: live\nconsequence: every running session is interrupted' }] };
  const d2 = fm.askOwnershipDefects(ok);
  check('a well-formed user-held ask → no defect', d2.length === 0, JSON.stringify(d2));
}

// ── [5] telemetry
console.log('[5] telemetry records the subject');
{
  const parsed = { blocks: [
    { name: 'orchard-ask', content: 'One more round.\nconfidence: med\nabout: Round\ndecider: direction\nconsequence: shipping now leaves an edge case' },
    { name: 'orchard-ask', content: 'Restart.\nconfidence: high\nabout: action\ndecider: live\nconsequence: every running session is interrupted' },
  ] };
  const rec = typeof fm.buildRecord === 'function' ? fm.buildRecord(parsed) : {};
  check('askSubjects = [round, action], asksAgentOwned = 1',
    JSON.stringify(rec.askSubjects) === '["round","action"]' && rec.asksAgentOwned === 1,
    `askSubjects=${JSON.stringify(rec.askSubjects)} asksAgentOwned=${rec.asksAgentOwned}`);
}

fs.rmSync(TMP, { recursive: true, force: true });
fs.rmSync(DATA, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILED:\n  - ' + failures.join('\n  - ')); process.exit(1); }
