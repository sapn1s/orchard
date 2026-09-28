#!/usr/bin/env node
/**
 * BUG-192 — the Stop hook's response-format gate (1) blocked replies over the
 * read-during-write race (grading the PREVIOUS message from the transcript tail),
 * (2) hard-blocked over-length replies (forcing a costly second generation), and
 * (3) counted table/quote/link words the readability check excludes.
 *
 *   node scripts/verify-bug-192-stop-hook-race-and-length.mjs
 *
 * Drives the REAL hook binary as a subprocess with a real Stop payload on stdin,
 * exactly as Claude Code does, over throwaway transcripts and a throwaway data dir.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const HOOK = path.join(ROOT, 'scripts', 'hooks', 'response-format-gate.mjs');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-192-data-'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-192-tx-'));

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${observed}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}

const DIGEST = '```orchard-digest\n{ "items": [ { "text": "x.", "kind": "fyi", "importance": "low" } ] }\n```';
const words = (n) => Array.from({ length: n }, (_, i) => `word${i % 7}`).join(' ');

/** Write a transcript whose tail is `replyText`. */
function tx(name, replyText) {
  const p = path.join(TMP, `${name}.jsonl`);
  const line = JSON.stringify({
    type: 'assistant', isSidechain: false,
    message: { id: `msg_${name}`, role: 'assistant', content: [{ type: 'text', text: replyText }] },
  });
  fs.writeFileSync(p, line + '\n');
  return p;
}

/** Run the hook. `lastMsg` (if set) is placed in the payload's last_assistant_message.
 *  `enforce:true` sets ORCHARD_STOP_HOOK_ENFORCE=1. */
function runHook(transcriptPath, { stopHookActive = false, sid = 'sess-x', lastMsg = undefined, enforce = false } = {}) {
  const payload = { session_id: sid, cwd: '/tmp', transcript_path: transcriptPath, hook_event_name: 'Stop', stop_hook_active: stopHookActive };
  if (lastMsg !== undefined) payload.last_assistant_message = lastMsg;
  const env = { ...process.env, ORCHARD_SESSION: sid, CLAUDE_STATION_DATA: DATA };
  delete env.ORCHARD_STOP_HOOK_ENFORCE;
  if (enforce) env.ORCHARD_STOP_HOOK_ENFORCE = '1';
  let out = '';
  try {
    out = execFileSync('node', [HOOK], { input: JSON.stringify(payload), encoding: 'utf8', env });
  } catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
  let sys = null, reason = null;
  try { const j = JSON.parse(out); sys = j.systemMessage ?? null; reason = j.reason ?? null; } catch { /* block or empty */ }
  return { blocked: /"decision":"block"/.test(out), out, sys, reason };
}
const mentionsLength = (s) => typeof s === 'string' && /(words of prose|the budget is|length budget)/i.test(s);

async function main() {
  const { proseVolume, evaluateLength } = await import(path.join(ROOT, 'scripts', 'lib', 'format-metrics.mjs'));
  const { parseResponseBlocks } = await import(path.join(ROOT, 'public', 'lib', 'response-blocks.js'));

  /* ---- [1] THE RACE — grade the payload, not the stale transcript tail ---- */
  console.log('\n[1] BUG-192 read-during-write race');
  const prevLong = `${DIGEST}\n\`\`\`\`orchard-finding\n${words(453)}\n\`\`\`\``;   // previous, flushed
  const curShort = `${DIGEST}\n\`\`\`\`orchard-outcome\n${words(113)}\n\`\`\`\``;   // current, in payload
  const raceTx = tx('race', prevLong);
  check('race: stale 453-word tail + compliant 113-word payload → ALLOWED (was a false block)',
    !runHook(raceTx, { lastMsg: curShort }).blocked, 'allowed');

  /* ---- [2] LENGTH is ADVISORY — over-budget never blocks ---- */
  console.log('\n[2] BUG-192 length budget is advisory (never a second generation)');
  const over = runHook(tx('over', 'x'), { lastMsg: `${DIGEST}\n\`\`\`\`orchard-finding\n${words(400)}\n\`\`\`\`` });
  check('a 400-word over-budget reply is NOT blocked', !over.blocked, over.blocked ? over.out.slice(0, 120) : 'allowed');
  check('the over-budget reply still gets an advisory systemMessage mentioning the budget',
    typeof over.sys === 'string' && /budget/.test(over.sys), String(over.sys).slice(0, 120));

  /* ---- [3] OTHER enforced checks keep blocking, on the race-immune payload ---- */
  console.log('\n[3] ask-ownership still blocks — on payload text (blockSafe)');
  const unowned = `${DIGEST}\n\`\`\`\`orchard-ask\nThere is a breaking bug which will corrupt data.\nconfidence: high\nNot sure if you want to fix it though.\n\`\`\`\``;
  check("high-confidence-no-decider ask in the payload → BLOCKED", runHook(tx('ao', 'x'), { lastMsg: unowned }).blocked, 'blocked');

  /* ---- [4] STALE fallback (no payload field) must NOT block ---- */
  console.log('\n[4] transcript fallback (payload lacks last_assistant_message) never blocks');
  check('unowned ask read from the transcript tail (no payload) → NOT blocked (may be stale)',
    !runHook(tx('stale', unowned)).blocked, 'allowed');

  /* ---- [5] recovery cap unchanged ---- */
  console.log('\n[5] one-correction cap still holds');
  check('unowned-ask payload WITH stop_hook_active=true → ALLOWED',
    !runHook(tx('cap', 'x'), { lastMsg: unowned, stopHookActive: true }).blocked, 'allowed');

  /* ---- [6] COUNTER excludes tables / quotes / links (matches readability) ---- */
  console.log('\n[6] proseVolume excludes tables, blockquotes and link targets');
  const tableHeavy = [
    'The one-line summary here is short.',                      // ~6 prose words
    '',
    '| col a | col b | col c |',
    '| --- | --- | --- |',
    '| alpha beta gamma | delta epsilon zeta | eta theta iota |',
    '| kappa lambda mu | nu xi omicron | pi rho sigma |',
    '',
    '> quoted evidence one two three four five six seven eight',
    '',
    'See https://example.com/some/very/long/path/that/has/many/slug/words/here',
    'and [the label text](https://example.com/another/long/target/url/words).',
  ].join('\n');
  const parsedTable = parseResponseBlocks(`${DIGEST}\n\`\`\`\`orchard-finding\n${tableHeavy}\n\`\`\`\``);
  const pv = proseVolume(parsedTable);
  const rawWords = (tableHeavy.match(/[A-Za-z][A-Za-z'-]*/g) || []).length;
  check(`proseWords (${pv.proseWords}) is far below a raw word count (${rawWords}) — table/quote/link excluded`,
    pv.proseWords > 0 && pv.proseWords < rawWords - 20, `prose=${pv.proseWords} raw=${rawWords}`);
  check('a reply that is only a short line + a big table/quote/links stays UNDER the 120 budget',
    evaluateLength(parsedTable).over === false, JSON.stringify(evaluateLength(parsedTable)));

  /* ---- [7] round-2 clean-room breaks: length NEVER blocks, blockSafe gates ALL blocks ---- */
  console.log('\n[7] BUG-192 round 2 — length never in a block reason; no block under any env unless blockSafe');
  // Attack 1 (DEFAULT env): an unowned ask that is ALSO over-length. The ask blocks,
  // but the block reason must NOT carry length feedback to the regeneration.
  const askAndLong = `${DIGEST}\n\`\`\`\`orchard-ask\nThere is a breaking bug which will corrupt data.\nconfidence: high\nNot sure if you want to fix it though.\n${words(400)}\n\`\`\`\``;
  const a1 = runHook(tx('a1', 'x'), { lastMsg: askAndLong });
  check('attack1: unowned-ask+over-length → BLOCKED but the reason contains NO length feedback',
    a1.blocked && !mentionsLength(a1.reason), `blocked=${a1.blocked} lenInReason=${mentionsLength(a1.reason)}`);
  // Attack 2 (ENFORCE=1): an over-length-ONLY reply must NOT block under any env.
  const a2 = runHook(tx('a2', 'x'), { lastMsg: `${DIGEST}\n\`\`\`\`orchard-finding\n${words(400)}\n\`\`\`\``, enforce: true });
  check('attack2: over-length-only reply with ORCHARD_STOP_HOOK_ENFORCE=1 → NOT blocked',
    !a2.blocked, a2.blocked ? a2.reason?.slice(0, 100) : 'allowed');
  // Attack 3 (ENFORCE=1): a stale-transcript fallback (no payload field) must NOT block.
  const noDigestLong = `Prose with no digest at all. ${words(120)}`; // substantive, missing-digest defect
  const a3 = runHook(tx('a3', noDigestLong), { enforce: true }); // no lastMsg → transcript fallback
  check('attack3: stale transcript fallback with ORCHARD_STOP_HOOK_ENFORCE=1 → NOT blocked',
    !a3.blocked, a3.blocked ? 'blocked' : 'allowed');
  // Guard: ENFORCE=1 with a blockSafe format defect STILL blocks (the opt-in path is intact).
  const a4 = runHook(tx('a4', 'x'), { lastMsg: noDigestLong, enforce: true });
  check('guard: ENFORCE=1 + blockSafe missing-digest → BLOCKED (opt-in path unbroken)',
    a4.blocked, a4.blocked ? 'blocked' : 'allowed');

  /* ---- [8] round-3: extractProse excludes tilde fences, pipeless tables, relative links ---- */
  console.log('\n[8] BUG-192 round 3 — counter excludes tilde code, GFM pipeless tables, relative-link targets');
  const rawWordsOf = (s) => (s.match(/[A-Za-z][A-Za-z'-]*/g) || []).length;
  const tildeBody = 'Short prose lead here.\n~~~js\nconst alpha = beta + gamma + delta + epsilon + zeta + eta + theta;\n~~~\nShort prose tail.';
  const pvTilde = proseVolume(parseResponseBlocks(`${DIGEST}\n\`\`\`\`orchard-finding\n${tildeBody}\n\`\`\`\``));
  check(`tilde-fenced code excluded (prose ${pvTilde.proseWords} << raw ${rawWordsOf(tildeBody)})`,
    pvTilde.proseWords < rawWordsOf(tildeBody) - 6, `prose=${pvTilde.proseWords} raw=${rawWordsOf(tildeBody)}`);
  const pipeless = 'Lead sentence here.\ncol alpha | col beta | col gamma\n--- | --- | ---\nx one | y two | z three\nk four | m five | n six\nTail sentence here.';
  const pvTable = proseVolume(parseResponseBlocks(`${DIGEST}\n\`\`\`\`orchard-finding\n${pipeless}\n\`\`\`\``));
  check(`GFM pipeless table excluded (prose ${pvTable.proseWords} << raw ${rawWordsOf(pipeless)})`,
    pvTable.proseWords < rawWordsOf(pipeless) - 12, `prose=${pvTable.proseWords} raw=${rawWordsOf(pipeless)}`);
  const relLink = 'See [the local guide document here](../docs/guide/verification.md) for the full rationale and steps.';
  const pvLink = proseVolume(parseResponseBlocks(`${DIGEST}\n\`\`\`\`orchard-finding\n${relLink}\n\`\`\`\``));
  check(`relative-link target excluded, label kept (prose ${pvLink.proseWords} < raw ${rawWordsOf(relLink)})`,
    pvLink.proseWords < rawWordsOf(relLink) && pvLink.proseWords >= 10, `prose=${pvLink.proseWords} raw=${rawWordsOf(relLink)}`);

  console.log(`\nTOTAL: ${pass} passed, ${fail} failed`);
  if (failures.length) console.log('failing checks:\n  - ' + failures.join('\n  - '));
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((err) => { console.error(`FATAL: ${err.stack ?? err.message}`); process.exitCode = 1; })
  .finally(() => { for (const dir of [DATA, TMP]) fs.rmSync(dir, { recursive: true, force: true }); });
