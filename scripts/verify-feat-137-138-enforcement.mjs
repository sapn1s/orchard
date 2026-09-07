#!/usr/bin/env node
/**
 * FEAT-137 / FEAT-138 — the ENFORCED response-format checks.
 *
 *   node scripts/verify-feat-137-138-enforcement.mjs
 *
 * FEAT-125 made the length budget INJECTED ADVICE and FEAT-127 made it (and the
 * ask-ownership rule) MEASURED — but both stayed advisory, and FEAT-127's own
 * numbers showed 65% of turns over the 120-word budget. This suite proves the two
 * checks are now ENFORCED by the Stop hook: an over-budget reply and an unowned
 * ask are BLOCKED for one immediate revision, while compliant replies pass
 * untouched.
 *
 * ROUND 2 — the confidence/decider spec is now injected into RESPONSE_FORMAT.md's
 * core, so `missing-confidence` (an ask with no `confidence:` line at all) is
 * PROMOTED from recorded-only to a block: every launched session has been told to
 * declare a confidence, so an ask that declares none is a non-compliant ask, not an
 * un-spec'd session's legitimate silence. This suite asserts that promotion.
 *
 * It drives the REAL hook binary as a subprocess with a real Stop payload on
 * stdin, exactly as Claude Code does, over throwaway transcripts and a throwaway
 * data dir (never the user's telemetry). No mocks.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const HOOK = path.join(ROOT, 'scripts', 'hooks', 'response-format-gate.mjs');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-136-data-'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-136-tx-'));

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${observed}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}

const DIGEST = '```orchard-digest\n{ "items": [ { "text": "x.", "kind": "done", "importance": "high" } ] }\n```';
function tx(name, replyText) {
  const p = path.join(TMP, `${name}.jsonl`);
  const line = JSON.stringify({
    type: 'assistant', isSidechain: false,
    message: { id: `msg_${name}`, role: 'assistant', content: [{ type: 'text', text: replyText }] },
  });
  fs.writeFileSync(p, line + '\n');
  return p;
}
const words = (n) => Array.from({ length: n }, (_, i) => `word${i % 7}`).join(' ');

/** Run the hook against a transcript; returns { blocked, out }. */
function runHook(transcriptPath, { stopHookActive = false, sid = 'sess-x' } = {}) {
  const payload = JSON.stringify({
    session_id: sid, cwd: '/tmp', transcript_path: transcriptPath,
    hook_event_name: 'Stop', stop_hook_active: stopHookActive,
  });
  let out = '';
  try {
    out = execFileSync('node', [HOOK], {
      input: payload, encoding: 'utf8',
      env: { ...process.env, ORCHARD_SESSION: sid, CLAUDE_STATION_DATA: DATA },
    });
  } catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
  return { blocked: /"decision":"block"/.test(out), out };
}

async function main() {
  const { evaluateLength, askOwnershipDefects } = await import(path.join(ROOT, 'scripts', 'lib', 'format-metrics.mjs'));
  const { parseResponseBlocks } = await import(path.join(ROOT, 'public', 'lib', 'response-blocks.js'));

  /* ---- [1] FEAT-138 length budget: over → BLOCK, under → ALLOW ---- */
  console.log('\n[1] FEAT-138 — length budget is ENFORCED');
  const overBudget = tx('over', `${DIGEST}\n\`\`\`\`orchard-finding\n${words(160)}\n\`\`\`\``);
  check('a 160-word non-ask reply (budget 120) is BLOCKED for revision', runHook(overBudget).blocked, 'blocked');
  const under = tx('under', `${DIGEST}\n\`\`\`\`orchard-outcome\n${words(40)}\n\`\`\`\``);
  check('a 40-word compliant reply is ALLOWED (no false positive)', !runHook(under).blocked, 'allowed');

  // handoff budget: an ASK turn gets 250, the same words with NO ask gets 120.
  const askBig = tx('askbig', `${DIGEST}\n\`\`\`\`orchard-ask\nShip now or wait? I recommend now.\nconfidence: med\ndecider: risk appetite — a weekend deploy trades speed for coverage.\n${words(180)}\n\`\`\`\``);
  check('a 200-word ASK turn (owned) is ALLOWED under the 250 handoff budget', !runHook(askBig).blocked, 'allowed');
  const nonAskBig = tx('nonaskbig', `${DIGEST}\n\`\`\`\`orchard-finding\n${words(200)}\n\`\`\`\``);
  check('the SAME 200 words with NO ask is BLOCKED (120 budget applies)', runHook(nonAskBig).blocked, 'blocked');

  /* ---- [2] FEAT-137 ask ownership: coupled to the confidence protocol ---- */
  console.log('\n[2] FEAT-137 — ask ownership is ENFORCED for confidence-declared asks');
  const highNoDecider = tx('highnd', `${DIGEST}\n\`\`\`\`orchard-ask\nThere is a breaking bug which will corrupt data.\nconfidence: high\nNot sure if you want to fix it though, so I will leave it.\n\`\`\`\``);
  check("the user's verbatim case (high confidence, NO decider) is BLOCKED", runHook(highNoDecider).blocked, 'blocked');
  const medNoDecider = tx('mednd', `${DIGEST}\n\`\`\`\`orchard-ask\nBlue or green? I recommend blue.\nconfidence: med\n\`\`\`\``);
  check('a med-confidence ask with NO decider is BLOCKED (protocol engaged, unowned)', runHook(medNoDecider).blocked, 'blocked');
  const owned = tx('owned', `${DIGEST}\n\`\`\`\`orchard-ask\nBlue or green? I recommend blue.\nconfidence: high\ndecider: taste — the brand palette is your call.\n\`\`\`\``);
  check('a fully-owned ask (confidence + decider) is ALLOWED', !runHook(owned).blocked, 'allowed');

  // ROUND 2 — the spec is now injected, so the coupling that kept missing-confidence
  // advisory is satisfied: an ask with NO confidence line is a non-compliant ask and
  // is BLOCKED for one revision. (Round 1 asserted the opposite here, deliberately,
  // while the spec was undelivered; that safety property has been retired by the
  // injection — see the file header.)
  const noConfidence = tx('noconf', `${DIGEST}\n\`\`\`\`orchard-ask\nShould I use blue or green? I recommend blue.\n\`\`\`\``);
  check('an ask with NO confidence line is BLOCKED (missing-confidence promoted, round 2)',
    runHook(noConfidence).blocked, 'blocked');

  /* ---- [3] recovery: one correction only, never a loop ---- */
  console.log('\n[3] recovery path — a re-prompt can never strand the user');
  check('over-budget WITH stop_hook_active=true is ALLOWED (the one-correction cap holds)',
    !runHook(overBudget, { stopHookActive: true }).blocked, 'allowed');

  /* ---- [4] disable switch still wins ---- */
  console.log('\n[4] kill switch');
  let disabledOut = '';
  try {
    disabledOut = execFileSync('node', [HOOK], {
      input: JSON.stringify({ session_id: 'sess-x', cwd: '/tmp', transcript_path: overBudget, hook_event_name: 'Stop', stop_hook_active: false }),
      encoding: 'utf8',
      env: { ...process.env, ORCHARD_SESSION: 'sess-x', CLAUDE_STATION_DATA: DATA, ORCHARD_STOP_HOOK_DISABLED: '1' },
    });
  } catch (e) { disabledOut = e.stdout || ''; }
  check('ORCHARD_STOP_HOOK_DISABLED=1 makes even an over-budget turn pass', !/"decision":"block"/.test(disabledOut), 'allowed');

  /* ---- [5] pure-function contracts ---- */
  console.log('\n[5] pure helpers in format-metrics.mjs');
  const parseTx = (p) => parseResponseBlocks(JSON.parse(fs.readFileSync(p, 'utf8').trim()).message.content[0].text);
  const lenOver = evaluateLength(parseTx(overBudget));
  check('evaluateLength: 160-word non-ask → over, ceiling 120',
    lenOver.over === true && lenOver.ceiling === 120, JSON.stringify(lenOver));
  check('askOwnershipDefects: high confidence + no decider → high-confidence-no-decider',
    askOwnershipDefects(parseTx(highNoDecider))[0]?.defect === 'high-confidence-no-decider',
    JSON.stringify(askOwnershipDefects(parseTx(highNoDecider))));
  check('askOwnershipDefects: no confidence line → missing-confidence (now ENFORCED, round 2)',
    askOwnershipDefects(parseTx(noConfidence))[0]?.defect === 'missing-confidence',
    JSON.stringify(askOwnershipDefects(parseTx(noConfidence))));

  console.log(`\nTOTAL: ${pass} passed, ${fail} failed`);
  if (failures.length) console.log('failing checks:\n  - ' + failures.join('\n  - '));
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(`FATAL: ${err.stack ?? err.message}`);
  process.exitCode = 1;
}).finally(() => {
  for (const dir of [DATA, TMP]) fs.rmSync(dir, { recursive: true, force: true });
});
