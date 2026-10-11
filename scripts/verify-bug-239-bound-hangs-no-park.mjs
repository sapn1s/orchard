#!/usr/bin/env node
/**
 * BUG-239 — "bound hangs, never park": the persistent proof suite.
 *
 *   node scripts/verify-bug-239-bound-hangs-no-park.mjs            # all arms (real CLI, ~6-10 min)
 *   node scripts/verify-bug-239-bound-hangs-no-park.mjs --fast     # pure arms only (real transcripts, no CLI)
 *   node scripts/verify-bug-239-bound-hangs-no-park.mjs --root <tree> [--only A|B]
 *        run the real-CLI arms against ANOTHER source tree (e.g. a pinned pre-fix
 *        copy) — they must FAIL there; that is the recorded must-FAIL proof.
 *
 * GUARANTEES, each with an arm that can see it broken:
 *   A1  a lane's permission card that nobody answers is REFUSED at its deadline
 *       (never approved: the file the tool would write does not exist), the
 *       refusal reaches the lane verbatim, is persisted in the incident ledger,
 *       and shows on the Needs-You rail; a late answer is refused (settled once).
 *   A2  the card escalates to the Needs-You rail before the deadline.
 *   A-MUT  same run with the deadline switched off (= pre-fix behaviour): the
 *       card is STILL pending past the deadline — proves A1's checks can fail.
 *   B1  a FOREGROUND lane that starts a background shell and tries to end is
 *       held by the guard, its child runs to completion (unique token on disk),
 *       and the lane reports after it.
 *   B-MUT  same run with the guard off (= pre-fix): the child started (handshake
 *       file) but never finished — the CLI killed it at the lane's turn end.
 *   P*  pure arms on REAL lane transcripts discovered at runtime (fail loudly if
 *       none qualify), truncated copies, provenance forgeries, bounds, budget
 *       (a FIFO that never yields), and parser/registration mutations.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { isolatedServerEnv, isolatedStoreEnv } from './lib/station-boot.mjs';

const args = process.argv.slice(2);
const FAST = args.includes('--fast');
const rootIdx = args.indexOf('--root');
const ROOT = rootIdx >= 0 ? path.resolve(args[rootIdx + 1]) : path.resolve(import.meta.dirname, '..');
const onlyIdx = args.indexOf('--only');
const ONLY = onlyIdx >= 0 ? args[onlyIdx + 1] : null;
const HERE_ROOT = path.resolve(import.meta.dirname, '..');
const KEEP = args.includes('--keep'); // keep scratch dirs for inspection (printed)

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  const line = typeof observed === 'string' ? observed : JSON.stringify(observed);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${line}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ pure arms */

async function pureArms() {
  const pg = await import(pathToFileURL(path.join(HERE_ROOT, 'src/server/park-guard.ts')).href);
  const ad = await import(pathToFileURL(path.join(HERE_ROOT, 'src/server/approval-deadline.ts')).href);
  const cfg = pg.guardConfigFromEnv({});

  console.log('\n=== P1. real lane transcripts: every launch kind is recognised (discovered at runtime) ===');
  const stores = [path.join(os.homedir(), '.claude', 'projects')];
  const find = (needle) => {
    for (const s of stores) {
      const r = spawnSync('rg', ['-l', '-F', '--max-count', '1', '-g', 'agent-*.jsonl', needle, s], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      if (r.error) throw new Error(`rg is required for the real-transcript arms: ${r.error.message}`);
      const files = r.stdout.split('\n').filter(Boolean).sort();
      if (files.length) return files;
    }
    return [];
  };
  const kinds = [
    ['shell', 'Command running in background with ID: '],
    ['monitor', 'Monitor started (task '],
    ['subagent', 'Async agent launched successfully.'],
  ];
  const realByKind = {};
  for (const [kind, needle] of kinds) {
    const files = find(needle);
    // A few, deterministically: first, middle, last of the sorted list.
    const pick = files.length ? [...new Set([files[0], files[Math.floor(files.length / 2)], files[files.length - 1]])] : [];
    let found = 0;
    let checked = 0;
    for (const f of pick) {
      const text = fs.readFileSync(f, 'utf8');
      const scan = pg.scanTranscript(text);
      checked++;
      if ([...scan.launched.values()].includes(kind)) { found++; realByKind[kind] ??= { file: f, text, scan }; }
    }
    check(`P1 ${kind}: a real lane transcript's ${kind} launch is parsed (≥1 of ${pick.length} sampled; FAILS LOUDLY when none exist)`,
      pick.length > 0 && found > 0, { candidates: files.length, sampled: checked, recognised: found });
  }

  console.log('\n=== P2. the guard BLOCKS on a real parked lane, and allows once its children are gone ===');
  const real = realByKind.shell ?? realByKind.monitor;
  if (real) {
    const ids = [...real.scan.launched.keys()];
    const tasks = ids.map((id) => ({ id, type: real.scan.launched.get(id), status: 'running', description: 'x' }));
    const live = pg.decideSubagentStop({ scan: real.scan, tasks: [...tasks, { id: 'zz-not-mine', type: 'shell', status: 'running' }], prior: undefined, now: 0, cfg });
    check('P2a live children the lane launched → block, naming exactly those ids (an unrelated live task is ignored)',
      live.action === 'block' && live.children.every((c) => ids.includes(c.id)) && !live.children.some((c) => c.id === 'zz-not-mine') && ids.every((id) => live.reason.includes(id)),
      { action: live.action, children: live.children.map((c) => c.id), file: path.basename(real.file) });
    const gone = pg.decideSubagentStop({ scan: real.scan, tasks: [], prior: undefined, now: 0, cfg });
    const unreadIds = pg.unreadFinishedChildren(real.scan, []).map((c) => c.id);
    check('P2b children gone: allow unless a finished child was never referenced again (then block as unread)',
      unreadIds.length ? gone.action === 'block' : gone.action === 'allow', { action: gone.action, unread: unreadIds });
    // MUTATION — empty parser: the same real transcript must then NOT block, so P2a can fail.
    const saved = [...pg.LAUNCH_PATTERNS];
    pg.LAUNCH_PATTERNS.splice(0, pg.LAUNCH_PATTERNS.length);
    let mutated;
    try { mutated = pg.decideSubagentStop({ scan: pg.scanTranscript(real.text), tasks, prior: undefined, now: 0, cfg }); } finally { pg.LAUNCH_PATTERNS.push(...saved); }
    check('P2-MUT with the launch parser emptied, the real parked lane is NOT blocked (P2a can see a broken parser)',
      mutated.action === 'allow', { action: mutated.action });
  } else {
    check('P2 needs a real shell or monitor lane transcript', false, 'none found');
  }

  console.log('\n=== P3. truncated real transcripts (another process writes them) never throw and never invent ids ===');
  if (real) {
    const full = real.scan.launched;
    let ok = true; const seen = [];
    for (const frac of [0.1, 0.33, 0.5, 0.77, 0.95, 0.999]) {
      const cut = real.text.slice(0, Math.floor(real.text.length * frac));
      let s;
      try { s = pg.scanTranscript(cut); } catch (e) { ok = false; seen.push(`${frac}:threw ${e.message}`); continue; }
      const invented = [...s.launched.keys()].filter((id) => !full.has(id));
      if (invented.length) ok = false;
      seen.push(`${frac}:${s.launched.size}/${full.size} bad=${s.badLines}`);
    }
    check('P3 every truncation parses tolerantly; ids found are a subset of the full transcript\'s', ok, seen.join(' '));
  }

  console.log('\n=== P4. provenance: a launch string not led by the CLI, or from the wrong tool, is not a launch ===');
  const rec = (o) => JSON.stringify(o);
  const forged = [
    rec({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cat old.jsonl' } }] } }),
    rec({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'line 1\nCommand running in background with ID: forged1. Output…' }] } }),
    rec({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/x' } }] } }),
    rec({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'Command running in background with ID: forged2.' }] } }),
    rec({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'x', run_in_background: true } }] } }),
    rec({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't3', content: 'Command running in background with ID: real1. Output is being written to: /tmp/x' }] } }),
  ].join('\n');
  const fs4 = pg.scanTranscript(forged);
  check('P4 only the Bash result LED by the CLI announcement counts (forged mid-output and wrong-tool ids do not)',
    fs4.launched.size === 1 && fs4.launched.has('real1'), [...fs4.launched.keys()]);

  console.log('\n=== P4b. finished-but-unread: a nested agent with no notice is held; a notified one, or a quiet shell, is not ===');
  const agentLaunch = [
    rec({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'g1', name: 'Agent', input: { prompt: 'x', run_in_background: true } }] } }),
    rec({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'g1', content: [{ type: 'text', text: 'Async agent launched successfully. (internal)\nagentId: aChild123 (internal ID)' }] }] } }),
    rec({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'g2', name: 'Bash', input: { command: 'sleep 5', run_in_background: true } }] } }),
    rec({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'g2', content: 'Command running in background with ID: bQuiet1. Output is being written to: /tmp/q' }] } }),
  ].join('\n');
  const unread = pg.decideSubagentStop({ scan: pg.scanTranscript(agentLaunch), tasks: [], prior: undefined, now: 0, cfg });
  const notified = pg.decideSubagentStop({
    scan: pg.scanTranscript(`${agentLaunch}\n${rec({ type: 'user', message: { content: '[SYSTEM NOTIFICATION]\n<task-notification>\n<task-id>aChild123</task-id>\n<status>completed</status>\n</task-notification>' } })}`),
    tasks: [], prior: undefined, now: 0, cfg,
  });
  check('P4b unread finished nested agent → block naming it; once its notice is in the transcript → allow; the quiet finished shell never blocks',
    unread.action === 'block' && unread.children.map((c) => c.id).join() === 'aChild123' && notified.action === 'allow',
    { unread: unread.action, ids: unread.children.map((c) => c.id), notified: notified.action });
  // The shape a real held lane recorded on CLI 2.1.281: the notice is an ATTACHMENT (queued_command), not a user message.
  const viaAttachment = pg.decideSubagentStop({
    scan: pg.scanTranscript(`${agentLaunch}\n${rec({ type: 'attachment', attachment: { type: 'queued_command', prompt: '<task-notification>\n<task-id>aChild123</task-id>\n<status>completed</status>\n</task-notification>' } })}`),
    tasks: [], prior: undefined, now: 0, cfg,
  });
  check('P4c a completion notice delivered as a queued_command ATTACHMENT (the real CLI 2.1.281 shape) counts as seen → allow',
    viaAttachment.action === 'allow', { action: viaAttachment.action });

  console.log('\n=== P5. bounds: ignored attempts release; a successful tool call resets; ceiling; expired permission ===');
  const scan0 = pg.scanTranscript(forged); // real1 launched, okResults=3
  const tasks = [{ id: 'real1', type: 'shell', status: 'running', command: 'sleep 99' }];
  let st; const acts = [];
  for (let k = 0; k < 4; k++) {
    const d = pg.decideSubagentStop({ scan: scan0, tasks, prior: st, now: k, cfg });
    acts.push(d.action + (d.parked ? `:${d.why}` : ''));
    st = d.state ?? st;
  }
  check('P5a with no tool call between attempts: block ×3, then allow as parked "ignored" (limit 3)',
    acts.join(',') === 'block,block,block,allow:ignored', acts.join(','));
  const s1 = pg.decideSubagentStop({ scan: scan0, tasks, prior: undefined, now: 0, cfg }).state;
  const s2 = pg.decideSubagentStop({ scan: scan0, tasks, prior: s1, now: 1, cfg }).state;
  const progressed = { ...scan0, okResults: scan0.okResults + 1 };
  const d3 = pg.decideSubagentStop({ scan: progressed, tasks, prior: s2, now: 2, cfg });
  check('P5b a successful tool call between attempts resets the ignored count (a waiting lane is held)',
    d3.action === 'block' && d3.state.ignored === 0, { action: d3.action, ignored: d3.state?.ignored });
  const errOnly = pg.scanTranscript(forged + '\n' + rec({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tx', is_error: true, content: 'denied' }] } }));
  const d4 = pg.decideSubagentStop({ scan: errOnly, tasks, prior: s1, now: 1, cfg });
  check('P5c a FAILED/denied tool call is not progress (no cycling against a permission refusal)',
    d4.state?.ignored === 1, { ignored: d4.state?.ignored });
  const ceil = pg.decideSubagentStop({ scan: progressed, tasks, prior: s1, now: cfg.ceilingMs + 1, cfg });
  check('P5d past the awake-time ceiling the stop is allowed and reported as parked "ceiling"',
    ceil.action === 'allow' && ceil.why === 'ceiling', { action: ceil.action, why: ceil.why });
  const pe = pg.decideSubagentStop({ scan: scan0, tasks, prior: undefined, now: 0, cfg, permissionExpired: true });
  check('P5e a lane whose permission expired is let go at once and reported (no guard/permission cycle)',
    pe.action === 'allow' && pe.why === 'permission-expired', { action: pe.action, why: pe.why });

  console.log('\n=== P6. the hook body: budget on a read that never returns (FIFO), and the expiry nudge ===');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bug239-p6-'));
  try {
    const fifo = path.join(tmp, 'never.jsonl');
    const mk = spawnSync('mkfifo', [fifo]);
    if (mk.status === 0) {
      const parked = [];
      const t0 = Date.now();
      const v = await pg.subagentStopVerdict(
        { agent_id: 'a1', agent_transcript_path: fifo, background_tasks: tasks },
        { cfg: { ...cfg, budgetMs: 400, lateCapMs: 500 }, states: new Map(), expiryNudged: new Set(), permissionExpired: () => false, onParked: (r) => parked.push(r) },
      );
      const took = Date.now() - t0;
      await sleep(900); // the single record is written at the late cap, not at the budget
      check('P6a a transcript read that never returns: ALLOW within its budget, then exactly ONE "cannot-judge" record at the late cap',
        !v.decision && took < 2000 && parked.length === 1 && parked[0].why === 'cannot-judge' && /had not finished/.test(parked[0].detail), { decision: v.decision ?? 'allow', tookMs: took, parked: parked.map((p) => `${p.why}: ${p.detail}`) });
      // Unblock the pending open so the process can exit.
      try { const fd = fs.openSync(fifo, fs.constants.O_RDWR | fs.constants.O_NONBLOCK); fs.closeSync(fd); } catch { /* ignore */ }
    } else check('P6a mkfifo available', false, mk.stderr?.toString());
    const nudgedSet = new Set();
    const deps = { cfg, states: new Map(), expiryNudged: nudgedSet, permissionExpired: () => true, onParked: () => {} };
    const n1 = await pg.subagentStopVerdict({ agent_id: 'a2', agent_transcript_path: '/nonexistent', last_assistant_message: 'done', background_tasks: [] }, deps);
    const n2 = await pg.subagentStopVerdict({ agent_id: 'a2', agent_transcript_path: '/nonexistent', last_assistant_message: 'done', background_tasks: [] }, deps);
    const n3 = await pg.subagentStopVerdict({ agent_id: 'a3', agent_transcript_path: '/nonexistent', last_assistant_message: 'BLOCKED-ON-PERMISSION: Write — x', background_tasks: [] }, deps);
    check('P6b a lane with an expired permission is held ONCE to name it (BLOCKED-ON-PERMISSION), never twice, and not at all if it already did',
      n1.decision === 'block' && /BLOCKED-ON-PERMISSION/.test(n1.reason) && !n2.decision && !n3.decision, { n1: n1.decision, n2: n2.decision ?? 'allow', n3: n3.decision ?? 'allow' });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }

  console.log('\n=== P7. the deadline can only refuse; config is validated ===');
  for (const k of ['approval', 'question', 'plan']) {
    const m = ad.expiryMessage(1800000, k);
    check(`P7 expiry text for ${k} says NOT approved / timeout, not a user decision`, /NOT approved/.test(m) && /not a user decision/.test(m), m.slice(0, 90));
  }
  const c1 = ad.approvalDeadlineConfig({ CLAUDE_STATION_APPROVAL_DEADLINE_MS: '60000', CLAUDE_STATION_APPROVAL_ESCALATE_MS: '90000' });
  const c2 = ad.approvalDeadlineConfig({ CLAUDE_STATION_APPROVAL_DEADLINE_MS: '-5', CLAUDE_STATION_APPROVAL_ESCALATE_MS: 'abc' });
  const c3 = ad.approvalDeadlineConfig({ CLAUDE_STATION_APPROVAL_DEADLINE_MS: '1e30' });
  check('P7 config: escalate ≥ deadline is pulled below it; junk → defaults; huge → clamped to 24 h',
    c1.escalateMs === 30000 && c1.deadlineMs === 60000 && c2.deadlineMs === 1800000 && c2.escalateMs === 300000 && c3.deadlineMs === 86400000,
    { c1, c2, c3 });
  check('P7 the same request (lane+tool+input, key order irrelevant) has one key; another lane does not',
    ad.requestKey('a', 'Write', { b: 1, a: 2 }) === ad.requestKey('a', 'Write', { a: 2, b: 1 }) && ad.requestKey('a', 'Write', { a: 1 }) !== ad.requestKey('b', 'Write', { a: 1 }), 'ok');

  console.log('\n=== P8. registration: the guard is installed for EVERY session, outside any conditional ===');
  const rt = fs.readFileSync(path.join(HERE_ROOT, 'src/server/runtime/claude-runtime.ts'), 'utf8');
  const i = rt.indexOf('BUG-239 (B) — THE NO-PARKING GUARD');
  const pre = rt.slice(0, i);
  // The block must sit at the start()'s top level: every `{` opened since the hooks section closed again.
  const hooksStart = pre.lastIndexOf('if (gitBlockOn || config.orchestratorProfile');
  const between = pre.slice(hooksStart);
  const depth = [...between].reduce((d, ch) => d + (ch === '{' ? 1 : ch === '}' ? -1 : 0), 0);
  check('P8 SubagentStop guard is registered after the conditional hooks block closes (depth 0), gated only by its own switch (or the BUG-231 end) — not by git/profile hooks',
    i > 0 && hooksStart > 0 && depth === 0 && /if \(parkCfg\.enabled \|\| \(gitBlockOn && gitWindowKey\)\) \{\s*options\.hooks = \{\s*\.\.\.\(options\.hooks \?\? \{\}\),\s*SubagentStop: \[\.\.\.\(options\.hooks\?\.SubagentStop/.test(rt.slice(i)), { found: i > 0, depth });
}


/* ------------------------------------------- round-2 reproduction arms (R1, R2) */

const ROUND1 = path.join(HERE_ROOT, 'scripts/fixtures/bug-239/round1');

/**
 * R1 — "a refusal inside the 24 h window is shown however large the ledger has
 * grown". Run on the PINNED round-1 store (must reproduce the break: the refusal
 * vanishes behind the 512 KB byte tail) and on the current store (must hold).
 */
async function r1LedgerWindow(mod, round1) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bug239-r1-'));
  try {
    const now = Date.now();
    const refusal = { kind: 'permission-expired', projectId: 'p', sessionId: 's', agentId: 'aOld', tool: 'Write', summary: 'R1-REFUSAL-MARKER', at: new Date(now - 2 * 3600e3).toISOString() };
    const filler = (k) => ({ kind: 'lane-parked', projectId: 'p', sessionId: 's', agentId: `a${k}`, summary: `filler ${k} ${'x'.repeat(400)}`, at: new Date(now - 3600e3 + k).toISOString() });
    const file = path.join(tmp, 'lane-incidents.jsonl');
    const write = round1 ? (r) => mod.recordIncident(r, file) : (r) => mod.recordIncident(r, tmp);
    write(refusal);
    for (let k = 0; k < 1600; k++) write(filler(k)); // ≈ 700 KB after the refusal
    const got = round1 ? mod.recentIncidents({ projectId: 'p', now, file }) : mod.recentIncidents({ projectId: 'p', now, dir: tmp });
    return { shown: got.some((r) => r.summary === 'R1-REFUSAL-MARKER'), count: got.length, written: 1601 };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/**
 * R2 — "one SubagentStop produces at most one record, and that record is true".
 * The transcript read is held past the budget (a FIFO written late), so the
 * budget settles the verdict and the real judgement arrives afterwards.
 *   (i)  a live child the lane launched: the record must name it (round 1 said
 *        only "budget ran out" and left a stale guard state for the lane);
 *   (ii) a lane already held twice with no progress (the judgement says
 *        "parked: ignored"): exactly ONE record (round 1 wrote two).
 */
async function r2StopRace(pg) {
  const rec = (o) => JSON.stringify(o);
  const transcript = [
    rec({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 99', run_in_background: true } }] } }),
    rec({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Command running in background with ID: bRace01. Output is being written to: /tmp/x' }] } }),
  ].join('\n') + '\n';
  const tasks = [{ id: 'bRace01', type: 'shell', status: 'running', command: 'sleep 99' }];
  const runCase = async (prior) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bug239-r2-'));
    const fifo = path.join(tmp, 'agent.jsonl');
    if (spawnSync('mkfifo', [fifo]).status !== 0) throw new Error('mkfifo unavailable');
    const records = [];
    const cfg = { ...pg.guardConfigFromEnv({}), budgetMs: 150, lateCapMs: 3000 };
    const states = new Map(prior ? [['aRace', prior]] : []);
    const writer = setTimeout(() => { const fd = fs.openSync(fifo, 'w'); fs.writeSync(fd, transcript); fs.closeSync(fd); }, 600);
    try {
      const v = await pg.subagentStopVerdict(
        { agent_id: 'aRace', agent_transcript_path: fifo, background_tasks: tasks },
        { cfg, states, expiryNudged: new Set(), permissionExpired: () => false, onParked: (r) => records.push(r) },
      );
      await sleep(1500); // the late judgement lands well inside this
      return { verdict: v.decision ?? 'allow', records, staleState: states.has('aRace') };
    } finally { clearTimeout(writer); fs.rmSync(tmp, { recursive: true, force: true }); }
  };
  const live = await runCase(undefined);
  const ignored = await runCase({ firstBlockAt: 0, lastOkResults: 99, ignored: 2, blocks: 2 });
  return { live, ignored };
}

async function roundTwoArms() {
  console.log('\n=== R1. a refusal inside the window survives a large ledger (independent verify d8d016bd, break 1) ===');
  const old1 = await r1LedgerWindow(await import(pathToFileURL(path.join(ROUND1, 'lane-incidents.ts')).href), true);
  check('R1-MUST-FAIL on the pinned round-1 store the 2-h-old refusal is NOT shown (break reproduced: 512 KB byte tail)', !old1.shown, old1);
  const cur = await import(pathToFileURL(path.join(HERE_ROOT, 'src/server/lane-incidents.ts')).href);
  const new1 = await r1LedgerWindow(cur, false);
  check('R1 on the current store the refusal IS shown, with every in-window record (day-rotated whole-file read)', new1.shown && new1.count === new1.written, new1);
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bug239-r1b-'));
    try {
      const now = Date.now();
      cur.recordIncident({ kind: 'permission-expired', projectId: 'p', sessionId: 's', agentId: 'a', summary: 'in big file', at: new Date(now - 60e3).toISOString() }, tmp);
      const got = cur.recentIncidents({ projectId: 'p', now, dir: tmp, perFileCap: 10 });
      check('R1b a day file over its read cap is NOT silently dropped: a visible "NOT shown" notice names the file',
        got.some((r) => r.kind === 'park-guard-error' && /NOT shown/.test(r.summary)), got.map((r) => r.summary));
      const legacy = path.join(tmp, 'lane-incidents.jsonl');
      fs.writeFileSync(legacy, `${JSON.stringify({ kind: 'permission-expired', projectId: 'p', sessionId: 's', agentId: 'a', summary: 'LEGACY-MARKER', at: new Date(now - 120e3).toISOString() })}\n`);
      check('R1c a record in the round-1 single-file ledger is still shown (migration: nothing recorded earlier vanishes)',
        cur.recentIncidents({ projectId: 'p', now, dir: tmp }).some((r) => r.summary === 'LEGACY-MARKER'), 'ok');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }

  console.log('\n=== R2. one stop, one true record (independent verify d8d016bd, break 2) ===');
  const o = await r2StopRace(await import(pathToFileURL(path.join(ROUND1, 'park-guard.ts')).href));
  const oldTold = o.live.records.some((r) => /bRace01/.test(`${r.detail} ${JSON.stringify(r.children)}`));
  check('R2-MUST-FAIL on the pinned round-1 guard the break reproduces: the live child is never named (and/or the ignored stop records twice, and/or a stale state is left)',
    !oldTold || o.ignored.records.length > 1 || o.live.staleState, { liveRecords: o.live.records.map((r) => r.detail), ignoredRecords: o.ignored.records.length, staleState: o.live.staleState });
  const n = await r2StopRace(await import(pathToFileURL(path.join(HERE_ROOT, 'src/server/park-guard.ts')).href));
  check('R2(i) current: budget-allowed stop with a live child → exactly ONE record, and it names the child as likely lost',
    n.live.verdict === 'allow' && n.live.records.length === 1 && /bRace01/.test(n.live.records[0].detail) && /likely lost/.test(n.live.records[0].detail), n.live.records.map((r) => r.detail));
  check('R2(i) current: no stale guard state is left for the lane that was allowed to end', !n.live.staleState, { staleState: n.live.staleState });
  check('R2(ii) current: an over-budget stop whose late judgement is "parked: ignored" records exactly ONCE',
    n.ignored.records.length === 1, n.ignored.records.map((r) => `${r.why}: ${r.detail}`));
}

/* ------------------------------------------------------------- real-CLI arms */

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

async function bootServer(label, extraEnv) {
  const PORT = await freePort();
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), `bug239-${label}-data-`));
  const WORK = fs.mkdtempSync(path.join(os.tmpdir(), `bug239-${label}-work-`));
  const CFG = fs.mkdtempSync(path.join(os.tmpdir(), `bug239-${label}-cfg-`));
  const env = isolatedServerEnv({ PORT: String(PORT), CLAUDE_STATION_DATA: DATA, ...isolatedStoreEnv(CFG, { alsoReader: true }), ...extraEnv }, { requireStore: true });
  const log = [];
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  const BASE = `http://127.0.0.1:${PORT}`;
  let up = false;
  for (let k = 0; k < 120 && !up; k++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error(`${label}: server never became healthy:\n${log.join('').slice(-2000)}`);
  return { PORT, BASE, DATA, WORK, CFG, child, log, dirs: [DATA, WORK, CFG] };
}

function stopServer(s) {
  if (!s?.child || s.child.exitCode !== null) return;
  try { process.kill(s.child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(s.child.pid, 'SIGKILL'); } catch { /* gone */ } }, 3000).unref();
}

function openWs(PORT) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const events = [];
    ws.on('message', (raw) => { try { events.push(JSON.parse(String(raw))); } catch { /* ignore */ } });
    ws.once('open', () => res({ ws, events, send: (o) => ws.send(JSON.stringify(o)) }));
    ws.once('error', rej);
  });
}
const waitEv = async (events, pred, ms, from = 0) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const hit = events.slice(from).find(pred); if (hit) return hit; await sleep(200); }
  return null;
};

async function registerProject(s, name, permissionMode) {
  const reg = await (await fetch(`${s.BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: s.WORK, name, isolation: 'direct' }) })).json(); // pin direct: the guard and the deadline are runtime-level; a container adds nothing here
  const pid = reg.project?.id;
  if (!pid) throw new Error(`register failed: ${JSON.stringify(reg)}`);
  await (await fetch(`${s.BASE}/api/projects/${pid}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'haiku', permissionMode }) })).json();
  return pid;
}

function laneTranscripts(cfgDir) {
  const out = [];
  const walk = (d) => { let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/^agent-.*\.jsonl$/.test(e.name)) out.push(p); } };
  walk(path.join(cfgDir, 'projects'));
  return out;
}

async function boardNeeds(s, pid) {
  try { const b = await (await fetch(`${s.BASE}/api/projects/${pid}/board`)).json(); return Array.isArray(b?.needsYou) ? b.needsYou : []; } catch { return []; }
}

/** Last record timestamp of a lane transcript = when the lane stopped (ms), or null. */
function laneEndMs(text) {
  let last = null;
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { const t = Date.parse(JSON.parse(line).timestamp); if (Number.isFinite(t) && (last === null || t > last)) last = t; } catch { /* torn line */ }
  }
  return last;
}

/**
 * Run one real-CLI arm up to `attempts` times. The model is not deterministic,
 * so an attempt that did not EXERCISE the case (no lane card; a lane that chose
 * to wait on its own) is retried rather than graded either way — and after the
 * last attempt that is itself a loud FAIL, never a quiet pass.
 */
async function withAttempts(tag, attempts, run) {
  let last = null;
  for (let k = 1; k <= attempts; k++) {
    const r = await run(k);
    last = r;
    if (r.valid) {
      if (k > 1) console.log(`        info: ${tag} exercised on attempt ${k} (earlier: ${r.priorWhy ?? 'did not exercise the case'})`);
      for (const c of r.checks) check(...c);
      return;
    }
    console.log(`        info: ${tag} attempt ${k} did not exercise the case: ${r.why}`);
  }
  for (const c of last.checks.filter((c) => /PRECONDITION/.test(c[0]))) check(...c);
  check(`${tag} could be exercised within ${attempts} attempts`, false, last.why);
}

/** A1/A2 (or A-MUT when `mutation`): an unanswered lane permission card. */
async function armA({ mutation }) {
  const DEADLINE = 40_000, ESCALATE = 12_000;
  const label = mutation ? 'amut' : 'a';
  const tag = mutation ? 'A-MUT' : 'A';
  const checks = [];
  const rec = (n, ok, o) => checks.push([n, ok, o]);
  const s = await bootServer(label, mutation
    ? { CLAUDE_STATION_APPROVAL_DEADLINE_MS: '0', CLAUDE_STATION_APPROVAL_ESCALATE_MS: String(ESCALATE) }
    : { CLAUDE_STATION_APPROVAL_DEADLINE_MS: String(DEADLINE), CLAUDE_STATION_APPROVAL_ESCALATE_MS: String(ESCALATE) });
  try {
    const pid = await registerProject(s, `bug239-${label}`, 'default');
    const target = path.join(s.WORK, 'perm-probe.txt');
    const c = await openWs(s.PORT);
    c.send({
      type: 'start', projectId: pid, overrides: { model: 'haiku' },
      prompt: `Use the Agent tool (subagent_type "general-purpose"; do not run it in the background) to dispatch one subagent with exactly this task: "Use the Write tool to create the file ${target} containing exactly PERMPROBE. If the Write is refused, do not retry it and do not use any other tool; reply with the refusal text verbatim." Do not write the file yourself. When the subagent returns, repeat its reply verbatim and stop.`,
    });
    // Any card a LANE raises counts (the model may pick Write or Bash); the main thread's does not.
    const ask = await waitEv(c.events, (e) => e.t === 'approval-request' && typeof e.agentId === 'string' && e.agentId.length > 0, 240_000);
    const t0 = Date.now();
    rec(`${tag} PRECONDITION: a LANE's tool call reached the permission callback (approval-request with a subagent agentId)`,
      !!ask, ask && { toolName: ask.toolName, agentId: ask.agentId, input: JSON.stringify(ask.input).slice(0, 120) });
    if (!ask) {
      const seen = c.events.filter((e) => e.t === 'approval-request').map((e) => `${e.toolName}:${e.agentId ?? 'main'}`);
      return { valid: false, checks, why: `no lane card within 240 s (cards seen: ${seen.join(', ') || 'none'})` };
    }
    await sleep(ESCALATE + 4000);
    const needs1 = await boardNeeds(s, pid);
    const overdue = needs1.find((n) => String(n.id).startsWith('perm-wait-'));
    if (!mutation) rec('A2 after the escalation time the overdue card is on the Needs-You rail, naming the lane and its deadline',
      !!overdue && /waited/.test(overdue.title) && /REFUSES it \(never approves\)/.test(overdue.detail ?? ''), overdue ?? needs1.map((n) => n.id));
    await sleep(Math.max(0, DEADLINE - (Date.now() - t0)) + 15_000);
    // Round 2: the ledger is day-rotated under <data>/lane-incidents/; read every file of the run.
    const ledgerDir = path.join(s.DATA, 'lane-incidents');
    const ledger = (fs.existsSync(ledgerDir) ? fs.readdirSync(ledgerDir) : []).filter((f) => f.endsWith('.jsonl'))
      .flatMap((f) => fs.readFileSync(path.join(ledgerDir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
    const expired = ledger.find((r) => r.kind === 'permission-expired');
    const lanes = laneTranscripts(s.CFG).map((f) => fs.readFileSync(f, 'utf8'));
    const refusalReached = lanes.some((t) => t.includes('ORCHARD PERMISSION TIMEOUT'));
    if (mutation) {
      const before = c.events.length;
      c.send({ type: 'approval-response', requestId: ask.requestId, allow: false });
      const ack = await waitEv(c.events, (e) => e.t === 'ack' && e.of === 'approval-response' && e.requestId === ask.requestId, 15_000, before);
      rec('A-MUT with the deadline OFF the card is STILL pending past the deadline (A1 can see the hang): late answer matched, no refusal, no ledger record',
        ack?.matched === true && !expired && !refusalReached, { matched: ack?.matched, ledger: ledger.length, refusalReached });
    } else {
      rec('A1 the lane\'s card was REFUSED at the deadline: the refusal text reached the lane transcript', refusalReached, { laneTranscripts: lanes.length });
      rec('A1 NEVER approved: the file the lane wanted to create does not exist', !fs.existsSync(target), { exists: fs.existsSync(target) });
      rec('A1 persisted: a permission-expired record is in the incident ledger, naming the tool',
        !!expired && expired.tool === ask.toolName && /refused \(not approved\)/.test(expired.summary), expired ?? `ledger=${ledger.length}`);
      const needs2 = await boardNeeds(s, pid);
      const card = needs2.find((n) => String(n.id).startsWith('lane-incident-permission-expired'));
      rec('A1 visible: the Needs-You rail shows "Refused for no answer", and the overdue card is gone', !!card && !needs2.some((n) => String(n.id).startsWith('perm-wait-')), card?.title ?? needs2.map((n) => n.id));
      const before = c.events.length;
      c.send({ type: 'approval-response', requestId: ask.requestId, allow: true });
      const ack = await waitEv(c.events, (e) => e.t === 'ack' && e.of === 'approval-response' && e.requestId === ask.requestId, 15_000, before);
      rec('A1 a late ALLOW for the expired card is refused (matched:false) — it settled once, as a refusal', ack?.matched === false, ack);
      await sleep(3000);
      rec('A1 and the late allow did not run the tool either', !fs.existsSync(target), { exists: fs.existsSync(target) });
      const timing = expired ? Date.parse(expired.at) - t0 : null;
      rec('A1 the refusal came at the deadline, not early (≥ deadline − 2 s after the card was seen)', timing !== null && timing >= DEADLINE - 2000, { msAfterCard: timing, deadline: DEADLINE });
    }
    c.send({ type: 'close' });
    await sleep(1500);
    c.ws.close();
    return { valid: true, checks };
  } finally { stopServer(s); await sleep(3500); if (KEEP || checks.some((c) => !c[1])) { console.log(`        kept: ${s.dirs.join(' ')}`); fs.writeFileSync(path.join(s.DATA, 'server.log'), s.log.join('')); } else for (const d of s.dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); }
}

/** B1 (or B-MUT when `mutation`): a foreground lane tries to end with a live background shell. */
async function armB({ mutation }) {
  const label = mutation ? 'bmut' : 'b';
  const tag = mutation ? 'B-MUT' : 'B1';
  const checks = [];
  const rec = (n, ok, o) => checks.push([n, ok, o]);
  const s = await bootServer(label, mutation ? { CLAUDE_STATION_PARK_GUARD: '0' } : {});
  try {
    const pid = await registerProject(s, `bug239-${label}`, 'bypassPermissions');
    const token = `PARKPROBE-${process.pid}-${Date.now()}`;
    const started = path.join(s.WORK, 'child-started.txt');
    const done = path.join(s.WORK, 'child-done.txt');
    const CHILD_MS = 45_000;
    const cmd = `echo started > ${started}; sleep ${CHILD_MS / 1000}; echo ${token} > ${done}`;
    const c = await openWs(s.PORT);
    c.send({
      type: 'start', projectId: pid, overrides: { model: 'haiku' },
      prompt: `Use the Agent tool with run_in_background set to false (subagent_type "general-purpose"; it MUST run in the foreground — the Agent tool defaults to background on this CLI) to dispatch one subagent with exactly this task: "Run this exact Bash command with run_in_background set to true: ${cmd} — then end your turn right away by replying: LAUNCHED. If you are told you cannot end your turn yet, follow exactly what that message tells you to do, and in your final reply include the contents of ${done} if it exists." When the subagent returns, repeat its final reply verbatim and stop.`,
    });
    const end = await waitEv(c.events, (e) => e.t === 'turn-end', 420_000);
    let startedAt = null;
    for (let k = 0; k < 60 && !startedAt; k++) { if (fs.existsSync(started)) startedAt = fs.statSync(started).mtimeMs; else await sleep(1000); }
    rec(`${tag} PRECONDITION (handshake): the lane's background child started`, !!startedAt, { started: !!startedAt });
    if (!startedAt) {
      const evs = c.events.filter((e) => ['error', 'ack', 'turn-end', 'provider-error', 'session-init', 'status'].includes(e.t)).map((e) => `${e.t}:${JSON.stringify(e).slice(0, 160)}`).slice(-8);
      return { valid: false, checks, why: `the child never started (the lane did not run the command); last events: ${evs.join(' || ')}` };
    }
    // The case is a FOREGROUND lane (the CLI kills only those). The model may dispatch it in the
    // background despite the prompt — then the case was not exercised (retry, not graded).
    const metas = laneTranscripts(s.CFG).map((f) => { try { return JSON.parse(fs.readFileSync(f.replace(/\.jsonl$/, '.meta.json'), 'utf8')); } catch { return null; } });
    const shapes = metas.map((m) => m?.requestShape ?? 'unknown');
    rec(`${tag} PRECONDITION: the lane ran in the FOREGROUND (its .meta.json requestShape)`, shapes.length > 0 && shapes.every((x) => x === 'foreground'), { shapes });
    if (!shapes.length || !shapes.every((x) => x === 'foreground')) return { valid: false, checks, why: `the lane was not a foreground lane (requestShape ${shapes.join(',') || 'none'})` };
    // A live child finishes CHILD_MS after it started; wait past that so a killed one is distinguishable.
    await sleep(Math.max(0, startedAt + CHILD_MS + 15_000 - Date.now()));
    // Measure the lane only once its transcript has stopped growing (10 s quiet, 180 s cap).
    {
      let lastSize = -1, quietSince = Date.now();
      const t0 = Date.now();
      while (Date.now() - t0 < 180_000) {
        const size = laneTranscripts(s.CFG).reduce((n, f) => n + fs.statSync(f).size, 0);
        if (size !== lastSize) { lastSize = size; quietSince = Date.now(); } else if (Date.now() - quietSince >= 10_000) break;
        await sleep(1000);
      }
    }
    const finished = fs.existsSync(done) && fs.readFileSync(done, 'utf8').includes(token);
    const doneAt = finished ? fs.statSync(done).mtimeMs : null;
    const laneTexts = laneTranscripts(s.CFG).map((f) => fs.readFileSync(f, 'utf8'));
    const laneEnd = Math.max(...laneTexts.map(laneEndMs).filter((x) => x !== null), 0) || null;
    const endedEarly = laneEnd !== null && laneEnd < startedAt + CHILD_MS;
    const held = laneTexts.some((t) => t.includes('Orchard: you cannot end your turn yet'));
    const logHeld = s.log.join('').includes('BUG-239 park guard: held lane');
    const obs = { finished, held, logHeld, laneEndVsChildDueS: laneEnd ? Math.round((laneEnd - (startedAt + CHILD_MS)) / 1000) : null, turnEnded: !!end };
    if (mutation) {
      // Only meaningful when the lane really ended before its child was due — a model that chose to wait did not park.
      if (!endedEarly) return { valid: false, checks, why: `the lane did not end before its child was due (it waited on its own): ${JSON.stringify(obs)}` };
      rec('B-MUT with the guard OFF a lane that ended early LOST its child: started, never finished (B1 can see the loss)', !finished && !held, obs);
    } else {
      rec('B1 the guard HELD the lane at its turn end (block reason in the lane transcript and the server log)', held && logHeld, obs);
      rec('B1 the child ran to completion: its unique token is on disk', finished, obs);
      rec('B1 the lane outlived its child (last lane record after the child finished) — it was there to harvest it, not parked',
        finished && laneEnd !== null && doneAt !== null && laneEnd >= doneAt, { laneEndMinusChildDoneS: laneEnd && doneAt ? Math.round((laneEnd - doneAt) / 1000) : null });
      const allText = c.events.filter((e) => e.t === 'text' || e.t === 'turn-end').map((e) => JSON.stringify(e)).join(' ');
      console.log(`        info: the lane's reply echoed the child's token: ${allText.includes(token)} (model compliance, not graded)`);
      rec('B1 the turn ended (the guard did not become a hang)', !!end, { turnEnd: !!end });
    }
    c.send({ type: 'close' });
    await sleep(1500);
    c.ws.close();
    return { valid: true, checks };
  } finally { stopServer(s); await sleep(3500); if (KEEP || checks.some((c) => !c[1])) { console.log(`        kept: ${s.dirs.join(' ')}`); fs.writeFileSync(path.join(s.DATA, 'server.log'), s.log.join('')); } else for (const d of s.dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); }
}

async function main() {
  if (rootIdx < 0) { await pureArms(); await roundTwoArms(); }
  if (!FAST) {
    const N = Number(process.env.BUG239_ATTEMPTS ?? 3);
    if (!ONLY || ONLY === 'A') { console.log('\n=== A1/A2. a lane permission card nobody answers (real CLI) ==='); await withAttempts('A', N, () => armA({ mutation: false })); }
    if (!ONLY || ONLY === 'B') { console.log('\n=== B1. a foreground lane ends with a live background child (real CLI) ==='); await withAttempts('B1', N, () => armB({ mutation: false })); }
    if (rootIdx < 0 && (!ONLY || ONLY === 'A')) { console.log('\n=== A-MUT. deadline OFF (the pre-fix behaviour) ==='); await withAttempts('A-MUT', N, () => armA({ mutation: true })); }
    if (rootIdx < 0 && (!ONLY || ONLY === 'B')) { console.log('\n=== B-MUT. guard OFF (the pre-fix behaviour) ==='); await withAttempts('B-MUT', N, () => armB({ mutation: true })); }
  }
  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => { console.error(`\nFATAL: ${err.stack ?? err.message}`); process.exitCode = 1; })
  .finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 500));
