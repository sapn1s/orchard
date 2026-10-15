#!/usr/bin/env node
/**
 * BUG-256 — an ask passes the turn-end check only for a HARD STOP, with its consequence.
 *
 *   node scripts/verify-bug-256-hard-stop-decider.mjs
 *
 * FEAT-137 required every `orchard-ask` to carry a `decider:` line, but accepted ANY
 * text after it — `decider: none`, `decider: priority (whether to spend on it now)`.
 * Measured over 282 real asks (docs/research/unnecessary-asks-2026-10-14.md): naming
 * a decider did not separate the user's decisions from the agent's own (71/160 vs
 * 55/122 unnecessary). This suite drives the REAL hook binary with ask bodies taken
 * VERBATIM from real orchestrator transcripts (the corpus, not invented shapes):
 *   [1] agent-owned asks that passed before (priority / spend / risk / none) → BLOCKED
 *   [2] a hard-stop token with no consequence → BLOCKED
 *   [3] real hard stops (restart, git, product direction, money, access, a fact only
 *       the user has, a technical block) WITH their consequence → ALLOWED
 *   [4] the pure helper + telemetry agree with the hook.
 * Pre-fix, [1] and [2] FAIL (the hook allowed every one of them). No mocks; throwaway
 * transcripts and data dir.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const HOOK = path.join(ROOT, 'scripts', 'hooks', 'response-format-gate.mjs');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bug256-data-'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bug256-tx-'));

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${observed}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}

const DIGEST = '```orchard-digest\n{ "items": [ { "text": "x.", "kind": "decision", "importance": "high" } ] }\n```';
const REPLY_TEXT = new Map();
let n = 0;
// Since the ask-subject gate (verify-ask-subject-gate.mjs) every ask also declares
// `about:`. This suite tests the DECIDER grammar, so each fixture gets the honest
// user-held subject for its decider code; a fixture whose decider is not a code gets
// none, and is still refused by the decider check first.
const SUBJECT_FOR = { live: 'action', git: 'action', access: 'action', blocked: 'action', money: 'spend',
  taste: 'preference', direction: 'goal', info: 'fact', irreversible: 'approval', outward: 'approval' };
function withAbout(body) {
  if (/^[ \t>*+-]*about[ \t]*:/im.test(body)) return body;
  const m = /^([ \t>*+-]*)decider[ \t]*:[ \t]*(\S.*?)\r?$/im.exec(body);
  const subject = m && SUBJECT_FOR[m[2].trim().toLowerCase()];
  return subject ? body.replace(m[0], `${m[1]}about: ${subject}\n${m[0]}`) : body;
}
function tx(askBody) {
  askBody = withAbout(askBody);
  const p = path.join(TMP, `t${n++}.jsonl`);
  const text = `${DIGEST}\n\n\`\`\`\`orchard-ask\n${askBody}\n\`\`\`\``;
  fs.writeFileSync(p, JSON.stringify({
    type: 'assistant', isSidechain: false,
    message: { id: `msg_${n}`, role: 'assistant', content: [{ type: 'text', text }] },
  }) + '\n');
  REPLY_TEXT.set(p, text);
  return p;
}
function runHook(p) {
  const sid = `bug256-${path.basename(p)}`;
  const payload = JSON.stringify({
    session_id: sid, cwd: '/tmp', transcript_path: p, hook_event_name: 'Stop',
    stop_hook_active: false, last_assistant_message: REPLY_TEXT.get(p),
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
const short = (s) => s.split('\n').find((l) => /decider/i.test(l)) ?? s.slice(0, 80);

// ── real asks (verbatim bodies from orchestrator transcripts; the study's index in [])
const AGENT_OWNED = [
  // [97] 2026-10-07 — "should I file and fix?" with decider priority; user replied "ye pls file and fix"
  'Should I file this and have it fixed now?\nMy recommendation: when the server starts, write the new secret into the shims of sessions that are still running.\nconfidence: high\ndecider: priority (whether to spend on it now)',
  // [43] 2026-10-13 — "one more round?" under decider spend, after "fix effective immediately"
  'I recommend one more round, with a structural fix.\nExpect another long round: about an hour to build, plus a check.\nconfidence: med\ndecider: spend\nevidence: 3 independent checks; each round fixed the last break.',
  // [80] 2026-10-11 — decider: none, which the old check accepted
  'Recommendation: tell that session to try the git command again. It should go through now.\nconfidence: high\ndecider: none. This is just you nudging the session, since it may still think git is blocked.',
  // [275-shaped, 285] verify-or-ship under generic risk
  'I recommend accepting it and shipping. Three adversarial rounds with mutation kills is well past the usual bar.\nconfidence: high\ndecider: risk',
  // [234] build-next under priority
  'I recommend building BUG-207 next.\nconfidence: med\ndecider: priority (these are edge cases that fix themselves within seconds)',
  // [24] combo of two non-hard-stop words
  'Can I set up a nightly backup?\nconfidence: med\ndecider: risk/spend (whose disk, how much space)',
];
const NO_CONSEQUENCE = [
  // [264] 2026-10-13 — real product fork, but the line names no consequence
  'I recommend publishing it as an npm package installed globally (option A).\nconfidence: med\ndecider: direction',
  'Restart claude-station when convenient so the fix goes live.\nconfidence: high\ndecider: live',
];
const HARD_STOPS = [
  // [238] restart, relabelled from `risk` to the hard stop it actually is
  'I\'ve done the fix, but it only takes effect after a restart.\nconfidence: high\ndecider: live\nconsequence: restarting kills every live session, including this one',
  // [5] git hand-off under the user's standing rule
  'Commit these, then close the session.\nconfidence: high\ndecider: git\nconsequence: you do all git commits in this repo',
  // [266] product direction with its consequence
  'I recommend supporting Windows through WSL2 for v1.\nconfidence: med\ndecider: direction\nconsequence: whether native Windows is part of v1',
  // [26] real money
  'I recommend cancelling the ruleset form and not upgrading.\nconfidence: med\ndecider: money\nconsequence: GitHub Pro costs about $4/month of your money',
  // [261] credential only the user holds
  'Please log in again: run `claude` in a terminal on this machine, then tell me.\nconfidence: high\ndecider: access\nconsequence: the login needs your credentials',
  // [161] a fact only the user observed
  'Was there a queued row visible in the dock before it disappeared?\nconfidence: med\ndecider: info\nconsequence: only you saw the dock at that moment',
  // [113] a technical block the agent cannot clear
  'I need you to unblock command access for lanes.\nconfidence: high\ndecider: blocked\nconsequence: every lane command is held for an approval nobody can give',
  // [3] irreversible, outward
  'I recommend leaving the published history as it is.\nconfidence: med\ndecider: irreversible\nconsequence: removing it means rewriting main and force-pushing',
  'Push the cleanup on its own now?\nconfidence: high\ndecider: outward\nconsequence: it publishes to the public repository',
  // [15] taste with consequence; case + leading markdown tolerated
  'Please look at the after screenshots and tell me if this is good enough.\nconfidence: med\n- Decider: Taste\n- consequence: the look of your dashboard is your call',
];

async function main() {
  const { askOwnershipDefects, buildRecord } = await import(path.join(ROOT, 'scripts', 'lib', 'format-metrics.mjs'));
  const { parseResponseBlocks } = await import(path.join(ROOT, 'public', 'lib', 'response-blocks.js'));

  console.log('\n[1] agent-owned asks that the old check passed → BLOCKED');
  for (const body of AGENT_OWNED) {
    const r = runHook(tx(body));
    check(`blocked: ${short(body)}`, r.blocked, r.blocked ? 'blocked' : 'allowed');
  }
  {
    const r = runHook(tx(AGENT_OWNED[0]));
    check('the block message tells the agent to decide and continue, and lists the hard stops',
      /decide/i.test(r.out) && /irreversible/.test(r.out) && /live/.test(r.out) && /git/.test(r.out),
      r.out.slice(0, 160).replace(/\n/g, ' '));
  }

  console.log('\n[2] hard-stop token with no consequence → BLOCKED');
  for (const body of NO_CONSEQUENCE) {
    const r = runHook(tx(body));
    check(`blocked: ${short(body)}`, r.blocked && /consequence/i.test(r.out), r.blocked ? 'blocked' : 'allowed');
  }

  console.log('\n[3] real hard stops with their consequence → ALLOWED');
  for (const body of HARD_STOPS) {
    const r = runHook(tx(body));
    check(`allowed: ${short(body)}`, !r.blocked, r.blocked ? `blocked: ${r.out.slice(0, 200)}` : 'allowed');
  }

  console.log('\n[4] pure helper + telemetry');
  const parse = (body) => parseResponseBlocks(`${DIGEST}\n\n\`\`\`\`orchard-ask\n${withAbout(body)}\n\`\`\`\``);
  const d0 = askOwnershipDefects(parse(AGENT_OWNED[0]));
  check("askOwnershipDefects: `decider: priority …` → decider-not-hard-stop",
    d0.length === 1 && d0[0].defect === 'decider-not-hard-stop', JSON.stringify(d0));
  const d1 = askOwnershipDefects(parse(NO_CONSEQUENCE[0]));
  check("askOwnershipDefects: `decider: direction` alone → decider-no-consequence",
    d1.length === 1 && d1[0].defect === 'decider-no-consequence', JSON.stringify(d1));
  const d2 = askOwnershipDefects(parse(HARD_STOPS[0]));
  check('askOwnershipDefects: a hard stop with its consequence → no defect', d2.length === 0, JSON.stringify(d2));
  const rec = buildRecord(parse(HARD_STOPS[1]));
  check('buildRecord records the decider tokens for a later audit',
    Array.isArray(rec.deciderTokens) && rec.deciderTokens[0] === 'git', JSON.stringify(rec.deciderTokens));
  const recBad = buildRecord(parse(AGENT_OWNED[1]));
  check('buildRecord counts a non-hard-stop ask',
    recBad.asksNotHardStop === 1 && recBad.deciderTokens[0] === 'spend', JSON.stringify({ t: recBad.deciderTokens, n: recBad.asksNotHardStop }));
  // Unchanged FEAT-137 paths still hold.
  const noConf = askOwnershipDefects(parse('Do X?\ndecider: live — restarting kills sessions'));
  check('FEAT-137 unchanged: no confidence line → missing-confidence', noConf[0]?.defect === 'missing-confidence', JSON.stringify(noConf));
  const highNo = askOwnershipDefects(parse('Fix it?\nconfidence: high'));
  check('FEAT-137 unchanged: high confidence, no decider → high-confidence-no-decider', highNo[0]?.defect === 'high-confidence-no-decider', JSON.stringify(highNo));

  // ── ROUND 2 (design review after the r1 clean room broke it three ways) ──────
  // The contract is now WELL-FORMEDNESS of a typed declaration, not truth: the
  // LEADING token must be a hard stop (B1), the consequence may be in any script
  // (B3), and a relabel under a list code passes BY DESIGN and is MEASURED by
  // scripts/ask-audit.mjs's per-stop delegated-reply table (B2), not claimed prevented.
  console.log('\n[5] r2 — B1 joined-token bypass: a non-list LEADING token is blocked whatever follows');
  const JOINED = [
    'Should I fix the flaky test now?\nconfidence: high\ndecider: priority/live — restarting ends every running session',
    'Retry the commit step?\nconfidence: high\ndecider: none,git — you do all commits in this repo',
    'One more round?\nconfidence: med\ndecider: risk + live — a restart interrupts the running lanes',
    'Build BUG-207 next?\nconfidence: med\ndecider: (priority) live — restarting ends every running session',
    // a Cyrillic homoglyph "lіve" (U+0456) is not the code `live`
    'Restart now?\nconfidence: high\ndecider: lіve — restarting ends every running session',
    // plan-review (OpenAI 01a13974-b4a3): a list code as a PREFIX of a longer token is not that code
    'Restart now?\nconfidence: high\ndecider: live2 — restarting ends every running session',
    'Restart now?\nconfidence: high\ndecider: liveа — restarting ends every running session',
    'Restart now?\nconfidence: high\ndecider: live​priority — restarting ends every running session',
  ];
  for (const body of JOINED) {
    const r = runHook(tx(body));
    check(`blocked: ${short(body)}`, r.blocked && /not a hard stop/.test(r.out), r.blocked ? 'blocked' : 'allowed');
  }
  const recJoined = buildRecord(parse(JOINED[0]));
  check('telemetry records the WHOLE declared value (r3), never a joined hard stop (live) alone',
    recJoined.deciderTokens[0].startsWith('priority/live') && recJoined.asksNotHardStop === 1, JSON.stringify({ t: recJoined.deciderTokens, n: recJoined.asksNotHardStop }));

  console.log('\n[6] r2 — B3: a real stop whose consequence is not in Latin script → ALLOWED');
  const UNICODE = [
    'Перезапустить сервис сейчас?\nconfidence: high\ndecider: live\nconsequence: перезапуск завершит все работающие сессии',
    '现在重启服务吗？\nconfidence: high\ndecider: live\nconsequence: 重启服务会结束所有正在运行的会话',
    'Push it?\nconfidence: high\ndecider: outward\nconsequence: veröffentlicht öffentlich für alle',
  ];
  for (const body of UNICODE) {
    const r = runHook(tx(body));
    check(`allowed: ${short(body)}`, !r.blocked, r.blocked ? `blocked: ${r.out.slice(0, 160)}` : 'allowed');
  }
  const thin = runHook(tx('Restart?\nconfidence: high\ndecider: live\nconsequence: 重启'));
  check('a two-character CJK "consequence" is still not a consequence → blocked', thin.blocked && /consequence/i.test(thin.out), thin.blocked ? 'blocked' : 'allowed');

  console.log('\n[7] r2 — B2 relabel: passes by design, and the audit MEASURES it per hard stop');
  const RELABEL = 'Run the full test suite again before merging?\nconfidence: med\ndecider: money\nconsequence: running tests costs effort and time';
  const rr = runHook(tx(RELABEL));
  check('a relabel (spend→money) with a consequence is NOT claimed blocked — the honest contract', !rr.blocked, rr.blocked ? 'blocked' : 'allowed');
  {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'bug256-audit-'));
    const enc = 'proj';
    fs.mkdirSync(path.join(store, enc));
    const line = (o) => JSON.stringify(o);
    const askText = (body) => `${DIGEST}\n\n\`\`\`\`orchard-ask\n${body}\n\`\`\`\``;
    const turns = [
      ['please do the merge work', RELABEL, 'do what you recommend'],
      ['tidy up', RELABEL, 'up to you, stop asking'],
      ['merge it', RELABEL, 'yes, but not on main'],
      ['ship the fix', HARD_STOPS[0], 'not now, there is a demo running'],
      // r3 (clean room r2 BREAK 2): overlap and em-dash qualification
      ['merge again', RELABEL, 'yes, do what you recommend'],
      ['merge once more', RELABEL, 'yes — but not on main'],
      ['merge it now', RELABEL, 'yes'],
    ];
    const rows = [];
    turns.forEach(([u, ask, reply], i) => {
      rows.push(line({ type: 'user', timestamp: `2026-10-14T0${i}:00:00Z`, message: { role: 'user', content: u } }));
      rows.push(line({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: askText(ask) }] } }));
      rows.push(line({ type: 'user', timestamp: `2026-10-14T0${i}:30:00Z`, message: { role: 'user', content: reply } }));
    });
    fs.writeFileSync(path.join(store, enc, 's1.jsonl'), rows.join('\n') + '\n');
    let out = '';
    try {
      out = execFileSync('node', [path.join(ROOT, 'scripts', 'ask-audit.mjs'), '--dir', enc, '--json'],
        { encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECTS_DIR: store } });
    } catch (e) { out = String(e.stdout || ''); }
    let s = null; try { s = JSON.parse(out).summary; } catch { /* not json */ }
    const money = s?.byStop?.money, live = s?.byStop?.live;
    check('ask-audit reports the per-stop review signal: money 3 delegated-back + 1 affirmative of 6 ("yes, do what you recommend" is delegated ONLY; "yes, but…" and "yes — but…" are neither), live 0 of 1',
      money?.asks === 6 && money?.replied === 6 && money?.delegated === 3 && money?.affirmative === 1
        && live?.asks === 1 && live?.delegated === 0 && live?.affirmative === 0,
      JSON.stringify(s?.byStop ?? s ?? out.slice(0, 200)));
    let human = '';
    try {
      human = execFileSync('node', [path.join(ROOT, 'scripts', 'ask-audit.mjs'), '--dir', enc, '--stop', 'money', '--sample', '5'],
        { encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECTS_DIR: store } });
    } catch (e) { human = String(e.stdout || '') + String(e.stderr || ''); }
    const sampled = (human.match(/^#\d+ /gm) ?? []).length;
    check('ask-audit --stop money samples only that stop\'s asks for a reviewer (5 of 6 shown, no live ask)',
      sampled === 5 && !/decider=live/.test(human), human.split('\n').filter((l) => /^#\d|by stop|waved/.test(l)).join(' | ').slice(0, 300));
    fs.rmSync(store, { recursive: true, force: true });
  }

  // ── ROUND 3 (orchestrator adjudication after the r2 clean room's compound break) ──
  // EXACT GRAMMAR: the whole decider value, trimmed and case-folded, must EQUAL one
  // code; the consequence is its own `consequence:` line.
  console.log('\n[8] r3 — exact grammar: anything but one whole code is blocked, naming every valid code');
  const C = '\nconsequence: restarting ends every running session';
  const CODES = ['irreversible', 'outward', 'live', 'git', 'access', 'money', 'taste', 'direction', 'info', 'blocked'];
  const NOT_EXACT = [
    'live-priority', 'live_ops', 'live.priority', 'live:priority', "live'priority", 'live—priority', 'live–priority',
    'live/git', 'live/priority', 'live,git', 'live git', 'live live', 'live.', 'live!', '**live**', '`live`', '(live)', '"live"',
    'live — restarting ends every running session', 'live (restart)', 'live​', '​live', 'liveа', 'lіve',
    'ｌｉｖｅ', 'LİVE', 'живой', '直播', 'hard stop: live', 'none', 'priority',
  ];
  for (const v of NOT_EXACT) {
    const r = runHook(tx(`Restart now?\nconfidence: high\ndecider: ${v}${C}`));
    const named = CODES.every((c) => r.out.includes(c));
    check(`blocked + names all codes: decider: ${JSON.stringify(v)}`, r.blocked && /not a hard stop/.test(r.out) && named, r.blocked ? (named ? 'blocked, codes named' : 'blocked, codes NOT named') : 'allowed');
  }
  const empty = runHook(tx('Restart now?\nconfidence: high\ndecider:   ' + C));
  check('an empty decider value is blocked', empty.blocked, empty.blocked ? 'blocked' : 'allowed');

  console.log('\n[9] r3 — every exact code passes; case-fold and surrounding whitespace are tolerated; CRLF holds');
  for (const code of CODES) {
    const r = runHook(tx(`Ask?\nconfidence: med\ndecider: ${code}${C}`));
    check(`allowed: decider: ${code}`, !r.blocked, r.blocked ? `blocked: ${r.out.slice(0, 160)}` : 'allowed');
  }
  for (const v of ['LIVE', 'Live', '  ' + CODES[3] + '  ', 'DiReCtIoN', 'live\t']) {
    const r = runHook(tx(`Ask?\nconfidence: med\ndecider: ${v}${C}`));
    check(`allowed (case-fold/trim): decider: ${JSON.stringify(v)}`, !r.blocked, r.blocked ? `blocked: ${r.out.slice(0, 160)}` : 'allowed');
  }
  {
    const r = runHook(tx('Restart?\r\nconfidence: high\r\ndecider: live\r\nconsequence: restarting ends every running session\r'));
    check('CRLF ask with an exact code passes', !r.blocked, r.blocked ? `blocked: ${r.out.slice(0, 160)}` : 'allowed');
  }
  const dExact = askOwnershipDefects(parse(`Ask?\nconfidence: med\ndecider: live${C}`));
  const dCompound = askOwnershipDefects(parse(`Ask?\nconfidence: med\ndecider: live-priority${C}`));
  check('helper: exact code → no defect; compound → decider-not-hard-stop', dExact.length === 0 && dCompound[0]?.defect === 'decider-not-hard-stop', JSON.stringify({ dExact, dCompound }));
  const recC = buildRecord(parse(`Ask?\nconfidence: med\ndecider: live-priority${C}`));
  check('telemetry records the compound as declared (live-priority), not as live', recC.deciderTokens[0] === 'live-priority' && recC.asksNotHardStop === 1, JSON.stringify(recC.deciderTokens));

  console.log('\n[10] r3 — consequences in many scripts and languages pass; a missing consequence line is blocked');
  const LANG = [
    ['Russian', 'перезапуск завершит все работающие сессии'],
    ['Chinese', '重启服务会结束所有正在运行的会话'],
    ['Japanese', '再起動すると実行中のセッションがすべて終了します'],
    ['Korean', '재시작하면 실행 중인 모든 세션이 종료됩니다'],
    ['Arabic', 'إعادة التشغيل تنهي جميع الجلسات الجارية'],
    ['Hindi', 'पुनरारंभ करने से सभी चल रहे सत्र समाप्त हो जाएंगे'],
    ['Greek', 'η επανεκκίνηση τερματίζει όλες τις συνεδρίες'],
    ['Thai', 'การรีสตาร์ทจะปิดเซสชันที่กำลังทำงานทั้งหมด'],
    ['German', 'der Neustart beendet alle laufenden Sitzungen'],
    ['Hebrew', 'ההפעלה מחדש תסיים את כל ההפעלות הפעילות'],
  ];
  for (const [lang, cons] of LANG) {
    const r = runHook(tx(`Restart?\nconfidence: high\ndecider: live\nconsequence: ${cons}`));
    check(`allowed: ${lang} consequence`, !r.blocked, r.blocked ? `blocked: ${r.out.slice(0, 160)}` : 'allowed');
  }
  const noLine = runHook(tx('Restart?\nconfidence: high\ndecider: live'));
  check('an exact code with no consequence line → blocked, told to add a consequence: line', noLine.blocked && /consequence:/.test(noLine.out), noLine.blocked ? 'blocked' : 'allowed');

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
