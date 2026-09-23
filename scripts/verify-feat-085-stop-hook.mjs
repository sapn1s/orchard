#!/usr/bin/env node
/**
 * FEAT-085 — Stop-hook response-format gate verification.
 *
 *   npm run verify:feat-085
 *
 * Drives the validator (scripts/hooks/response-format-gate.mjs) DIRECTLY with
 * crafted Stop-hook payloads + synthetic JSONL transcripts. No live session,
 * no server, no CLI turn — the transcript file IS the input. Free, fast, and
 * pollutes nothing (temp dir under the OS tmp, torn down at the end).
 *
 * We assert the ACTUAL contract the hook must honour:
 *   ALLOW = exit 0 AND no stdout (no corrective re-prompt emitted).
 *   BLOCK = exit 0 AND stdout is {"decision":"block","reason":...} naming the
 *           specific failure.
 *
 * Must-FAIL guard: the compliant case asserts stdout is EMPTY — a naive
 * always-block hook would re-prompt there and fail this assertion.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, 'hooks', 'response-format-gate.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'feat085-'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + JSON.stringify(detail) : '')); }
}

/** Write a JSONL transcript whose final MAIN-thread assistant message is `text`. */
function transcript(name, text, { extraTail = [] } = {}) {
  const file = path.join(TMP, name + '.jsonl');
  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
    JSON.stringify({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'subagent 🚀 noise no digest' }] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }),
    ...extraTail,
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

/*
 * BUG-118 (round 2): the Stop hook grades only the session its ORCHARD_SESSION
 * marker NAMES — a presence flag was inherited by nested hand-started sessions.
 * These suites test the GRADER, so each run declares itself the owner of the
 * payload it sends, injecting a session id when a fixture omits one (a real Stop
 * payload always carries one). The launcher gate is BUG-118's own suite.
 */
const SUITE_SESSION_ID = '0b118000-0000-4000-8000-000000000118';
const ownPayload = (o) => (o && typeof o === 'object' && typeof o.session_id !== 'string')
  ? { ...o, session_id: SUITE_SESSION_ID } : o;
const ownMarker = (o) => (o && typeof o?.session_id === 'string') ? o.session_id : SUITE_SESSION_ID;
/** Same, for suites that feed RAW stdin (including deliberate garbage). */
function ownRaw(input) {
  try {
    const o = JSON.parse(input);
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      const p = ownPayload(o);
      return { input: JSON.stringify(p), marker: ownMarker(p) };
    }
  } catch { /* garbage stays garbage: the hook must fail open on it */ }
  return { input, marker: SUITE_SESSION_ID };
}

/** Run the hook with a given payload object; returns {code, stdout}. */
function run(payload, env = {}) {
  const p = ownPayload(payload);
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify(p),
    encoding: 'utf8',
    env: { ...process.env, ORCHARD_SESSION: ownMarker(p), ORCHARD_STOP_HOOK_ENFORCE: "1", ...env },
    timeout: 15000,
  });
  return { code: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

function runRaw(input, env = {}) {
  const o = ownRaw(input);
  const r = spawnSync('node', [HOOK], { input: o.input, encoding: 'utf8', env: { ...process.env, ORCHARD_SESSION: o.marker, ORCHARD_STOP_HOOK_ENFORCE: "1", ...env }, timeout: 15000 });
  return { code: r.status, stdout: (r.stdout || '').trim() };
}

function isAllow(res) { return res.code === 0 && res.stdout === ''; }
function blockReason(res) {
  if (res.code !== 0 || !res.stdout) return null;
  try { const o = JSON.parse(res.stdout); return o.decision === 'block' ? String(o.reason || '') : null; }
  catch { return null; }
}

const GOOD = '```orchard-digest\n{"items":[{"text":"Shipped the gate","kind":"done","importance":"high"}]}\n```\nPlain prose below, no emoji.';

/* FEAT-143 — a MISSING digest is a defect only for a SUBSTANTIVE reply; a short
 * reply or a single-artifact reply legitimately omits it. Fixtures that assert
 * "no digest -> BLOCK" must therefore be substantive (>= 40 words of ordinary
 * prose) — the old one-line fixtures now legitimately ALLOW. Kept easy to read so
 * no readability reason muddies the missing-digest assertion. */
const SUBSTANTIVE = 'I reviewed the whole change and it holds together end to end. '
  + 'The parser handles every fence case, the renderer draws each block correctly, '
  + 'and the metrics record one line for every graded turn. I ran the suite twice '
  + 'and both passes were completely clean. Nothing here needs a decision from you '
  + 'right now, so I will pick up the next item.';

console.log('=== FEAT-085 Stop-hook gate ===');

/* 1. Compliant reply -> ALLOW, and NO corrective emitted (must-FAIL guard). */
{
  const tp = transcript('good', GOOD);
  const res = run({ hook_event_name: 'Stop', stop_hook_active: false, transcript_path: tp, cwd: '/nonexistent/proj' });
  check('compliant digest reply -> ALLOW', isAllow(res), res);
  check('compliant reply emits NO corrective (must-FAIL vs naive always-block)', res.stdout === '', res);
}

/* 2. Non-compliant variants -> BLOCK with a specific reason. */
{
  const tp = transcript('nodigest', SUBSTANTIVE);
  const res = run({ hook_event_name: 'Stop', stop_hook_active: false, transcript_path: tp, cwd: '/nonexistent/proj' });
  const reason = blockReason(res);
  check('substantive reply, no digest -> BLOCK', reason !== null, res);
  check('no digest -> reason names missing block', !!reason && /Missing the leading/.test(reason), reason);
}

/* 2b. FEAT-143 — the digest is a scan surface, not a mandatory preamble. A SHORT
 *     reply and a SINGLE-ARTIFACT reply legitimately omit it -> ALLOW. Guard:
 *     the single-artifact exemption must NOT rescue a substantive multi-part
 *     reply. */
{
  const tp = transcript('short-nodigest', 'Yes — done, pushed.');
  const res = run({ hook_event_name: 'Stop', stop_hook_active: false, transcript_path: tp, cwd: '/nonexistent/proj' });
  check('short reply, no digest -> ALLOW (digest suppressible)', isAllow(res), res);
}
{
  const artifact = '````orchard-answer\nHi Anna, we would like to view the flat this Saturday at 14:00 — does that work for you?\n````';
  const tp = transcript('answer-only', artifact);
  const res = run({ hook_event_name: 'Stop', stop_hook_active: false, transcript_path: tp, cwd: '/nonexistent/proj' });
  check('single orchard-answer artifact, no digest -> ALLOW', isAllow(res), res);
}
{
  // Anti-over-permissiveness: an answer block PLUS substantive loose prose is not a
  // single artifact -> a substantive reply still owes its digest -> BLOCK.
  const tp = transcript('answer-plus-prose',
    '````orchard-answer\nThe recommended flat is the one on Tallinas iela.\n````\n\n' + SUBSTANTIVE);
  const res = run({ hook_event_name: 'Stop', stop_hook_active: false, transcript_path: tp, cwd: '/nonexistent/proj' });
  check('answer block + substantive loose prose, no digest -> BLOCK (not a single artifact)',
    blockReason(res) !== null, res);
}
{
  const tp = transcript('malformed', '```orchard-digest\n{items: [broken}\n```\nprose');
  const res = run({ hook_event_name: 'Stop', stop_hook_active: false, transcript_path: tp, cwd: '/nonexistent/proj' });
  const reason = blockReason(res);
  check('malformed JSON -> BLOCK', reason !== null, res);
  check('malformed JSON -> reason names malformed JSON', !!reason && /malformed/i.test(reason), reason);
}
{
  const tp = transcript('empty-items', '```orchard-digest\n{"items":[]}\n```\nprose');
  const res = run({ hook_event_name: 'Stop', stop_hook_active: false, transcript_path: tp, cwd: '/nonexistent/proj' });
  const reason = blockReason(res);
  check('empty items -> BLOCK', reason !== null, res);
  check('empty items -> reason names no usable items', !!reason && /no usable items/i.test(reason), reason);
}
{
  // items present but each item has empty text -> parseDigest yields no usable items.
  const tp = transcript('blank-text', '```orchard-digest\n{"items":[{"text":"   ","kind":"done"}]}\n```\nprose');
  const res = run({ hook_event_name: 'Stop', stop_hook_active: false, transcript_path: tp, cwd: '/nonexistent/proj' });
  const reason = blockReason(res);
  check('items with blank text -> BLOCK (no usable items)', !!reason && /no usable items/i.test(reason), reason);
}
{
  // Valid digest but an emoji in the prose -> BLOCK on emoji only.
  const tp = transcript('emoji', GOOD.replace('no emoji.', 'oops 🚀'));
  const res = run({ hook_event_name: 'Stop', stop_hook_active: false, transcript_path: tp, cwd: '/nonexistent/proj' });
  const reason = blockReason(res);
  check('valid digest + emoji -> BLOCK', reason !== null, res);
  check('emoji -> reason names emojis', !!reason && /emoji/i.test(reason), reason);
  check('emoji -> reason does NOT falsely claim missing digest', !!reason && !/Missing the leading/.test(reason), reason);
}
{
  // Both failures at once: no digest AND emoji -> reason names BOTH.
  const tp = transcript('both', SUBSTANTIVE + ' Nice work 👍');
  const res = run({ hook_event_name: 'Stop', stop_hook_active: false, transcript_path: tp, cwd: '/nonexistent/proj' });
  const reason = blockReason(res);
  check('missing digest + emoji -> reason names both', !!reason && /Missing the leading/.test(reason) && /emoji/i.test(reason), reason);
}

/* 3. Loop safety: stop_hook_active === true on a non-compliant reply -> ALLOW. */
{
  const tp = transcript('loopsafe', 'no digest, would normally block 🚀');
  const res = run({ hook_event_name: 'Stop', stop_hook_active: true, transcript_path: tp, cwd: '/nonexistent/proj' });
  check('stop_hook_active:true on non-compliant -> ALLOW (loop cap)', isAllow(res), res);
}

/* 4. Fail-open paths. */
{
  const res = runRaw(''); // empty stdin
  check('empty stdin -> ALLOW (fail open)', isAllow(res), res);
}
{
  const res = runRaw('}{ not json at all'); // garbage stdin
  check('garbage stdin -> ALLOW (fail open)', isAllow(res), res);
}
{
  const res = run({ hook_event_name: 'Stop', stop_hook_active: false, transcript_path: path.join(TMP, 'does-not-exist.jsonl'), cwd: '/x' });
  check('missing transcript file -> ALLOW (fail open)', isAllow(res), res);
}
{
  const res = run({ hook_event_name: 'Stop', stop_hook_active: false, cwd: '/x' }); // no transcript_path
  check('no transcript_path -> ALLOW (fail open)', isAllow(res), res);
}
{
  // transcript exists but has no main-thread assistant text (only a sidechain msg)
  const file = path.join(TMP, 'sidechain-only.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'sub only, no digest' }] } }) + '\n');
  const res = run({ hook_event_name: 'Stop', stop_hook_active: false, transcript_path: file, cwd: '/x' });
  check('only sidechain assistant text -> ALLOW (nothing to check)', isAllow(res), res);
}
{
  // tool-only final assistant turn (no text block) -> nothing to check -> ALLOW
  const file = path.join(TMP, 'toolonly.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }) + '\n');
  const res = run({ hook_event_name: 'Stop', stop_hook_active: false, transcript_path: file, cwd: '/x' });
  check('tool-only final turn (no text) -> ALLOW', isAllow(res), res);
}
{
  // corrupt/truncated JSONL line before the good one -> loader skips bad lines
  const file = path.join(TMP, 'corrupt.jsonl');
  fs.writeFileSync(file, '{ this is not json\n' + JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: GOOD }] } }) + '\n');
  const res = run({ hook_event_name: 'Stop', stop_hook_active: false, transcript_path: file, cwd: '/x' });
  check('corrupt JSONL line skipped, good digest below -> ALLOW', isAllow(res), res);
}

/* 5. Disable switch -> inert even on a blatantly non-compliant reply. */
{
  const tp = transcript('disabled', 'no digest 🚀 whatsoever');
  for (const v of ['1', 'true', 'yes']) {
    const res = run({ hook_event_name: 'Stop', stop_hook_active: false, transcript_path: tp, cwd: '/x' }, { ORCHARD_STOP_HOOK_DISABLED: v });
    check('disable flag ' + JSON.stringify(v) + ' -> ALLOW (inert)', isAllow(res), res);
  }
  // falsey values must NOT disable
  const res0 = run({ hook_event_name: 'Stop', stop_hook_active: false, transcript_path: tp, cwd: '/x' }, { ORCHARD_STOP_HOOK_DISABLED: '0' });
  check('disable flag "0" does NOT disable (still BLOCKs)', blockReason(res0) !== null, res0);
}

/* 6. Per-project opt-out via the registry (responseDigest.enabled === false). */
{
  const dataDir = path.join(TMP, 'data');
  const projDir = path.join(TMP, 'optout-proj');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'registry.json'), JSON.stringify({
    version: 1,
    projects: [{ id: 'opt', hostPath: projDir, settings: { responseDigest: { enabled: false } } }],
  }));
  const tp = transcript('optout', SUBSTANTIVE);
  const res = run(
    { hook_event_name: 'Stop', stop_hook_active: false, transcript_path: tp, cwd: projDir },
    { CLAUDE_STATION_DATA: dataDir },
  );
  check('project with responseDigest.enabled=false -> ALLOW (inert)', isAllow(res), res);

  // Same registry, a DIFFERENT project (digest enabled/default) still blocks.
  fs.writeFileSync(path.join(dataDir, 'registry.json'), JSON.stringify({
    version: 1,
    projects: [{ id: 'on', hostPath: projDir, settings: { responseDigest: { enabled: true } } }],
  }));
  const res2 = run(
    { hook_event_name: 'Stop', stop_hook_active: false, transcript_path: tp, cwd: projDir },
    { CLAUDE_STATION_DATA: dataDir },
  );
  check('project with responseDigest.enabled=true -> BLOCK (gated)', blockReason(res2) !== null, res2);
}

/* 7. Split logical message across MULTIPLE JSONL lines sharing one message.id
 *    (Claude Code persists a turn as a thinking line + one or more text lines).
 *    The LIVE false block: the digest led an EARLIER line and the hook graded
 *    only the trailing prose line. The grader must concatenate the whole message. */
{
  // Write a transcript whose final logical assistant message (one id) is split
  // across `blocks` JSONL lines. `id` groups them; a leading thinking line is
  // included to mirror the real on-disk shape.
  function splitTranscript(name, id, textBlocks, { withThinking = true } = {}) {
    const file = path.join(TMP, name + '.jsonl');
    const mk = (content) => JSON.stringify({ type: 'assistant', isSidechain: false, message: { id, role: 'assistant', content } });
    const lines = [JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } })];
    if (withThinking) lines.push(mk([{ type: 'thinking', thinking: '', signature: 'sig' }]));
    for (const t of textBlocks) lines.push(mk([{ type: 'text', text: t }]));
    fs.writeFileSync(file, lines.join('\n') + '\n');
    return file;
  }

  // The REAL blocked reply (digest fence on the first text line, prose on the next).
  const realDigest =
    '```orchard-digest\n{\n  "items": [\n' +
    '    { "text": "Corrected CV line below — the reviewer is right on both counts, and the honest phrasing is also the stronger one.", "kind": "done", "importance": "med" },\n' +
    '    { "text": "Worth checking in your own setup: reflink copies only work within one filesystem, so if the agent writes through a Docker overlay rather than a bind-mounted host path, the guarantee may not hold as described.", "kind": "decision", "importance": "high" }\n' +
    '  ]\n}\n```';
  const realProse = '\n\n**Corrected line:**\n\n> …near-instant, space-efficient undo — a reviewer who knows btrfs will spot the difference.';

  // MUST-FAIL repro: fence line then prose line, one message.id.
  const tpSplit = splitTranscript('split-live', 'msg_LIVE', [realDigest, realProse]);
  const resSplit = run({ hook_event_name: 'Stop', stop_hook_active: false, transcript_path: tpSplit, cwd: '/nonexistent/proj' });
  check('LIVE repro: digest+prose split across JSONL lines (same id) -> ALLOW (pre-fix BLOCKED)', isAllow(resSplit), resSplit);

  // Same, but the split falls WITHIN the digest itself (fence-open on one line,
  // JSON+close on the next) — concatenation must still reconstruct a valid digest.
  const tpMid = splitTranscript('split-mid', 'msg_MID', [
    '```orchard-digest\n{"items":[{"text":"Shipped the gate","kind":"done","importance":"high"}]}',
    '\n```\nplain prose below',
  ]);
  const resMid = run({ hook_event_name: 'Stop', stop_hook_active: false, transcript_path: tpMid, cwd: '/nonexistent/proj' });
  check('digest fence split across two JSONL lines (same id) -> ALLOW', isAllow(resMid), resMid);

  // Guard against over-permissiveness: a split message that is ALL prose (no
  // digest on ANY line) must still BLOCK.
  const tpNc = splitTranscript('split-nc', 'msg_NC', [
    'I reviewed the whole change and it holds together end to end. The parser handles every fence case.',
    '\nThe renderer draws each block correctly and the metrics record one line per graded turn. I ran the suite twice and both passes were clean. Nothing here needs a decision from you right now.',
  ]);
  const resNc = run({ hook_event_name: 'Stop', stop_hook_active: false, transcript_path: tpNc, cwd: '/nonexistent/proj' });
  check('split message, all prose (no digest on any line) -> still BLOCK', blockReason(resNc) !== null, resNc);

  // Different-id neighbour must NOT be merged in: a PRIOR compliant turn must not
  // rescue a later non-compliant turn.
  const fileTwoTurns = path.join(TMP, 'two-turns.jsonl');
  fs.writeFileSync(fileTwoTurns, [
    JSON.stringify({ type: 'assistant', message: { id: 'msg_A', role: 'assistant', content: [{ type: 'text', text: GOOD }] } }),
    JSON.stringify({ type: 'assistant', message: { id: 'msg_B', role: 'assistant', content: [{ type: 'text', text: SUBSTANTIVE }] } }),
  ].join('\n') + '\n');
  const resTwo = run({ hook_event_name: 'Stop', stop_hook_active: false, transcript_path: fileTwoTurns, cwd: '/nonexistent/proj' });
  check('prior compliant turn (different id) does NOT rescue later non-compliant -> BLOCK', blockReason(resTwo) !== null, resTwo);

  // The race tail: final line is thinking-only (text not yet flushed) -> nothing
  // to check -> ALLOW (never a false block mid-stream).
  const tpThinkOnly = splitTranscript('think-only', 'msg_T', [], { withThinking: true });
  const resThink = run({ hook_event_name: 'Stop', stop_hook_active: false, transcript_path: tpThinkOnly, cwd: '/nonexistent/proj' });
  check('final logical message is thinking-only (mid-stream) -> ALLOW (no false block)', isAllow(resThink), resThink);
}

/* 9. ADVISORY MODE — the DEFAULT. Blocking must be impossible without the
 *    explicit ORCHARD_STOP_HOOK_ENFORCE opt-in. (Every check above runs with
 *    ENFORCE=1 injected by run()/runRaw(); here we clear it.) */
{
  const ADV = { ORCHARD_STOP_HOOK_ENFORCE: '' };
  const logDir = fs.mkdtempSync(path.join(TMP, 'advdata-'));
  const advEnv = { ...ADV, CLAUDE_STATION_DATA: logDir };
  const logFile = path.join(logDir, 'logs', 'stop-hook-advisory.log');

  // must-FAIL core: the blatantly non-compliant reply that BLOCKs under enforce.
  const tpBad = transcript('adv-bad', SUBSTANTIVE);
  const payBad = { hook_event_name: 'Stop', stop_hook_active: false, transcript_path: tpBad, cwd: '/nonexistent/proj' };

  const resEnf = run(payBad); // default runner env = ENFORCE=1
  check('ENFORCE=1 opt-in: non-compliant -> BLOCK (blocking still available)', blockReason(resEnf) !== null, resEnf);

  const resAdv = run(payBad, advEnv);
  check('ADVISORY default: non-compliant -> exit 0 (turn allowed)', resAdv.code === 0, resAdv);
  check('ADVISORY default: emits NO decision:block (must-FAIL vs the old blocking default)',
    blockReason(resAdv) === null && !/"decision"\s*:\s*"block"/.test(resAdv.stdout), resAdv);

  let advOut = null;
  try { advOut = JSON.parse(resAdv.stdout); } catch { /* leave null */ }
  check('ADVISORY: violation reported via non-blocking systemMessage',
    !!advOut && typeof advOut.systemMessage === 'string' && /orchard-digest/.test(advOut.systemMessage), resAdv.stdout);
  check('ADVISORY: systemMessage carries no `continue:false` / `decision` (cannot halt the turn)',
    !!advOut && advOut.decision === undefined && advOut.continue === undefined, resAdv.stdout);
  check('ADVISORY: violation also reported on stderr', /stop-hook advisory/.test(resAdv.stderr), resAdv.stderr);
  check('ADVISORY: violation appended to the out-of-repo log file',
    fs.existsSync(logFile) && /Missing the leading/.test(fs.readFileSync(logFile, 'utf8')), logFile);
  check('ADVISORY: log lives outside the repo (under the app data dir)',
    !path.resolve(logFile).startsWith(path.resolve(path.join(HERE, '..')) + path.sep), logFile);

  // A compliant reply must stay SILENT in advisory mode too — no advisory noise.
  const tpGood = transcript('adv-good', GOOD);
  const resAdvGood = run({ hook_event_name: 'Stop', stop_hook_active: false, transcript_path: tpGood, cwd: '/nonexistent/proj' }, advEnv);
  check('ADVISORY: compliant reply -> allowed silently (no advisory noise)', isAllow(resAdvGood), resAdvGood);

  // Falsey / bogus values of the opt-in must NOT enable blocking.
  for (const v of ['0', 'false', 'no', '', 'maybe']) {
    const r = run(payBad, { ORCHARD_STOP_HOOK_ENFORCE: v, CLAUDE_STATION_DATA: logDir });
    check(`ADVISORY: ORCHARD_STOP_HOOK_ENFORCE="${v}" does NOT enable blocking`, blockReason(r) === null, r);
  }
  for (const v of ['1', 'true', 'yes', 'TRUE', ' 1 ']) {
    const r = run(payBad, { ORCHARD_STOP_HOOK_ENFORCE: v });
    check(`ENFORCE: ORCHARD_STOP_HOOK_ENFORCE="${v}" enables blocking`, blockReason(r) !== null, r);
  }

  // Safety invariants must still hold in ADVISORY mode (never a block, never a crash).
  const advSafety = [
    ['loop cap (stop_hook_active)', run({ ...payBad, stop_hook_active: true }, advEnv)],
    ['disable env still inert', run(payBad, { ...advEnv, ORCHARD_STOP_HOOK_DISABLED: '1' })],
    ['missing transcript', run({ ...payBad, transcript_path: path.join(TMP, 'nope.jsonl') }, advEnv)],
    ['no transcript_path', run({ hook_event_name: 'Stop', stop_hook_active: false, cwd: '/x' }, advEnv)],
    ['directory as transcript', run({ ...payBad, transcript_path: TMP }, advEnv)],
    ['empty stdin', runRaw('', advEnv)],
    ['garbage stdin', runRaw('{not json at all', advEnv)],
  ];
  for (const [name, r] of advSafety) {
    check(`ADVISORY safety: ${name} -> silent ALLOW`, isAllow(r), r);
  }
}

/* teardown */
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

console.log('\n' + pass + '/' + (pass + fail) + ' checks passed');
process.exit(fail ? 1 : 0);
