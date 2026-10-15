#!/usr/bin/env node
/**
 * verify-late-answers.mjs — 2026-10-13 (defaults lane, BUG-239 follow-up): a lane's
 * permission card is REFUSED at its deadline (default 30 min). When the user then
 * approves or answers that card anyway, the moment is recorded in the lane-incident
 * ledger as a `late-answer` and counted by GET /api/lane-incidents/late-answers, so the
 * 30-min default can be judged on data. It is a count, never a Needs-You card.
 *
 *   node scripts/verify-late-answers.mjs            # unit + live (real Claude CLI, haiku) + must-FAIL mutant
 *   node scripts/verify-late-answers.mjs --unit     # the unit section only (no CLI, no server)
 *   node scripts/verify-late-answers.mjs --keep     # keep scratch dirs
 *
 * U  lateAnswerCounts over a ledger (SYNTHETIC records — stated: no real late answer existed
 *    before this change, so none can be read): counts by answer, window bound, lateShare,
 *    median; DATA_ONLY_KINDS holds late-answer; the route's 400 on a bad window.
 * L  LIVE, the REAL artifact: an isolated scratch server drives the REAL Claude CLI; a lane's
 *    Write card goes unanswered past a short deadline and is refused; then the user ALLOWS it
 *    over the real WebSocket. Asserts: the ack says matched:false + refusedForNoAnswer; the
 *    tool never ran; exactly one late-answer record (answer approved, lateByMs > 0, the
 *    requestId); a second click records nothing more; the count route reports it; the
 *    Needs-You rail shows the refusal but no late-answer card.
 * M  MUST-FAIL: the same live arm on a CONSTRUCTED mutant tree (scripts/lib/mutant-tree.mjs)
 *    whose answer paths never call #noteLateAnswer. The "late answer recorded" property must
 *    FAIL there; a mutant that passes is itself a FAIL (vacuous proof).
 *
 * Exit 0 = all PASS, 1 = a FAIL.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { isolatedServerEnv, isolatedStoreEnv } from './lib/station-boot.mjs';
import { buildMutantTree } from './lib/mutant-tree.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const UNIT_ONLY = args.includes('--unit');
const KEEP = args.includes('--keep');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0; let fail = 0; const failures = [];
function check(name, ok, observed) {
  const line = observed === undefined ? '' : `\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${line}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}

/* ───────────────────────────────────────────── U: the count, over a ledger */
{
  console.log('U  lateAnswerCounts (synthetic ledger records — no real late answer existed before this change)');
  const LI = await import(pathToFileURL(path.join(ROOT, 'src/server/lane-incidents.ts')).href);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'late-ans-unit-'));
  try {
    const now = Date.parse('2026-10-13T12:00:00Z');
    const at = (minAgo) => new Date(now - minAgo * 60_000).toISOString();
    const base = { projectId: 'p', sessionId: 's', agentId: 'a', summary: 'x' };
    for (let i = 0; i < 4; i++) LI.recordIncident({ ...base, kind: 'permission-expired', at: at(100 + i) }, dir);
    LI.recordIncident({ ...base, kind: 'late-answer', answer: 'approved', lateByMs: 60_000, at: at(50) }, dir);
    LI.recordIncident({ ...base, kind: 'late-answer', answer: 'approved', lateByMs: 180_000, at: at(40) }, dir);
    LI.recordIncident({ ...base, kind: 'late-answer', answer: 'denied', lateByMs: 120_000, at: at(30) }, dir);
    LI.recordIncident({ ...base, kind: 'late-answer', answer: 'answered', lateByMs: 600_000, projectId: 'other', at: at(20) }, dir);
    // outside a 1-day window, inside 30 days
    LI.recordIncident({ ...base, kind: 'late-answer', answer: 'approved', lateByMs: 1, at: at(3 * 24 * 60) }, dir);
    const all = LI.lateAnswerCounts({ now, dir });
    check('U1 30-day window: 4 refused, 5 late answers (3 approved, 1 denied, 1 answered)',
      all.refused === 4 && all.lateAnswers === 5 && all.lateApproved === 3 && all.lateDenied === 1 && all.lateAnswered === 1, all);
    const day = LI.lateAnswerCounts({ now, dir, windowMs: 24 * 3600e3 });
    check('U2 a 1-day window drops the 3-day-old record; median lateBy of 1/2/3/10 min = 2.5 min', day.lateAnswers === 4 && day.medianLateByMs === 150_000, day);
    const p = LI.lateAnswerCounts({ now, dir, windowMs: 24 * 3600e3, projectId: 'p' });
    check('U3 per project: only p\'s records; lateShare = 3/4', p.lateAnswers === 3 && p.refused === 4 && p.lateShare === 0.75, p);
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'late-ans-empty-'));
    const empty = LI.lateAnswerCounts({ now, dir: emptyDir });
    fs.rmSync(emptyDir, { recursive: true, force: true });
    check('U4 an empty ledger counts zero with null share/median (not NaN)', empty.lateAnswers === 0 && empty.refused === 0 && empty.lateShare === null && empty.medianLateByMs === null, empty);
    check('U5 late-answer is a DATA-ONLY kind (never a Needs-You card); permission-expired is not', LI.DATA_ONLY_KINDS.has('late-answer') && !LI.DATA_ONLY_KINDS.has('permission-expired'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/* ───────────────────────────────────────────── live harness (real CLI) */
async function freePort() {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
async function bootServer(root, label, extraEnv) {
  const PORT = await freePort();
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), `late-${label}-data-`));
  const WORK = fs.mkdtempSync(path.join(os.tmpdir(), `late-${label}-work-`));
  const CFG = fs.mkdtempSync(path.join(os.tmpdir(), `late-${label}-cfg-`));
  const env = isolatedServerEnv({ PORT: String(PORT), CLAUDE_STATION_DATA: DATA, ORCHARD_RELEASE_TICK: '0', ...isolatedStoreEnv(CFG, { alsoReader: true }), ...extraEnv }, { requireStore: true });
  const log = [];
  const child = spawn(process.execPath, [path.join(root, 'src', 'server', 'index.ts')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  const BASE = `http://127.0.0.1:${PORT}`;
  let up = false;
  for (let k = 0; k < 160 && !up; k++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
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
const ledgerOf = (DATA) => {
  const d = path.join(DATA, 'lane-incidents');
  return (fs.existsSync(d) ? fs.readdirSync(d) : []).filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) => fs.readFileSync(path.join(d, f), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
};

/**
 * One live arm: a lane's Write card, refused at DEADLINE, then allowed late.
 * Returns { valid, why, obs } — `valid` false = the model never raised a lane card (retry).
 */
async function liveArm(root, label) {
  const DEADLINE = 20_000; const ESCALATE = 6_000;
  const s = await bootServer(root, label, { CLAUDE_STATION_APPROVAL_DEADLINE_MS: String(DEADLINE), CLAUDE_STATION_APPROVAL_ESCALATE_MS: String(ESCALATE) });
  let keep = KEEP;
  try {
    const reg = await (await fetch(`${s.BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: s.WORK, name: `late-${label}`, isolation: 'direct' }) })).json();
    const pid = reg.project?.id;
    if (!pid) throw new Error(`register failed: ${JSON.stringify(reg)}`);
    await fetch(`${s.BASE}/api/projects/${pid}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'haiku', permissionMode: 'default' }) });
    const target = path.join(s.WORK, 'late-probe.txt');
    const c = await openWs(s.PORT);
    const startMsg = {
      type: 'start', projectId: pid, overrides: { model: 'haiku' },
      prompt: `Use the Agent tool (subagent_type "general-purpose"; do not run it in the background) to dispatch one subagent with exactly this task: "Use the Write tool to create the file ${target} containing exactly LATEPROBE. If the Write is refused, do not retry it and do not use any other tool; reply with the refusal text verbatim." Do not write the file yourself. When the subagent returns, repeat its reply verbatim and stop.`,
    };
    // A fresh server gates new host sessions until its bundled-runtime check completes:
    // re-send the start while it says so (bounded); never grade that refusal.
    for (let k = 0; k < 40; k++) {
      const from = c.events.length;
      c.send(startMsg);
      const gate = await waitEv(c.events, (e) => e.t === 'error' && /runtime check pending/.test(String(e.message)), 4000, from);
      if (!gate) break;
      await sleep(2000);
    }
    const ask = await waitEv(c.events, (e) => e.t === 'approval-request' && typeof e.agentId === 'string' && e.agentId.length > 0, 240_000);
    if (!ask) {
      c.ws.close();
      return { valid: false, why: `no lane card within 240 s (events: ${c.events.slice(0, 8).map((e) => `${e.t}:${String(e.message ?? e.status ?? e.of ?? '').slice(0, 80)}`).join(' | ')}; cards: ${c.events.filter((e) => e.t === 'approval-request').map((e) => `${e.toolName}:${e.agentId ?? 'main'}`).join(', ') || 'none'})` };
    }
    await sleep(DEADLINE + 6000);
    const refused = ledgerOf(s.DATA).find((r) => r.kind === 'permission-expired');
    const t0 = Date.now();
    let from = c.events.length;
    c.send({ type: 'approval-response', requestId: ask.requestId, allow: true });
    const ack = await waitEv(c.events, (e) => e.t === 'ack' && e.of === 'approval-response' && e.requestId === ask.requestId, 15_000, from);
    await sleep(1500);
    const late1 = ledgerOf(s.DATA).filter((r) => r.kind === 'late-answer');
    from = c.events.length;
    c.send({ type: 'approval-response', requestId: ask.requestId, allow: true });
    const ack2 = await waitEv(c.events, (e) => e.t === 'ack' && e.of === 'approval-response' && e.requestId === ask.requestId, 15_000, from);
    await sleep(1500);
    const late2 = ledgerOf(s.DATA).filter((r) => r.kind === 'late-answer');
    let count = null; let countStatus = null; let bad = null;
    try { const r = await fetch(`${s.BASE}/api/lane-incidents/late-answers?days=1`); countStatus = r.status; count = await r.json().catch(() => null); } catch { /* none */ }
    try { const r = await fetch(`${s.BASE}/api/lane-incidents/late-answers?days=0`); bad = r.status; } catch { /* none */ }
    let projCount = null;
    try { projCount = await (await fetch(`${s.BASE}/api/lane-incidents/late-answers?days=1&project=${encodeURIComponent(pid)}`)).json(); } catch { /* none */ }
    let needs = [];
    try { const b = await (await fetch(`${s.BASE}/api/projects/${pid}/board`)).json(); needs = Array.isArray(b?.needsYou) ? b.needsYou : []; } catch { /* none */ }
    const obs = { ask, refused, ack, ack2, late1, late2, count, countStatus, bad, projCount, needs: needs.map((n) => n.id), fileExists: fs.existsSync(target), lateClickAt: t0 };
    c.send({ type: 'close' });
    await sleep(1000);
    c.ws.close();
    return { valid: true, obs, setKeep: (v) => { keep = keep || v; } };
  } finally {
    stopServer(s); await sleep(3500);
    if (keep) { console.log(`        kept: ${s.dirs.join(' ')}`); fs.writeFileSync(path.join(s.DATA, 'server.log'), s.log.join('')); }
    else for (const d of s.dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 });
  }
}
async function withAttempts(root, label, n) {
  let r;
  for (let k = 1; k <= n; k++) {
    r = await liveArm(root, `${label}${k}`);
    if (r.valid) return r;
    console.log(`        info: ${label} attempt ${k} did not exercise the case: ${r.why}`);
  }
  return r;
}

if (!UNIT_ONLY) {
  console.log('L  LIVE: real Claude CLI (haiku) on an isolated scratch server — refuse at the deadline, then a late ALLOW');
  const L = await withAttempts(ROOT, 'l', 3);
  check('L0 PRECONDITION: a lane raised a permission card (the case was exercised)', L.valid, L.why);
  if (L.valid) {
    const o = L.obs;
    const rec = o.late1[0];
    check('L1 the deadline refused the card first (a permission-expired record exists)', !!o.refused, o.refused ?? 'none');
    check('L2 the late ALLOW is acked matched:false with refusedForNoAnswer:true (the client can say why)', o.ack?.matched === false && o.ack?.refusedForNoAnswer === true, o.ack);
    check('L3 the late ALLOW did not run the tool (the file does not exist)', o.fileExists === false, { exists: o.fileExists });
    check('L4 exactly one late-answer record: answer "approved", the requestId, the tool, the deadline, lateByMs > 0',
      o.late1.length === 1 && rec.answer === 'approved' && rec.requestId === o.ask.requestId && rec.tool === o.ask.toolName && rec.deadlineMs === 20_000 && rec.lateByMs > 0 && rec.waitedMs >= rec.lateByMs, o.late1);
    check('L5 the record\'s moment is the click (recorded within 5 s after it)', !!rec && Math.abs(Date.parse(rec.at) - o.lateClickAt) < 5000, rec && { at: rec.at, click: new Date(o.lateClickAt).toISOString() });
    check('L6 a second click on the same card records nothing more (counted once) and carries no refusedForNoAnswer', o.late2.length === 1 && o.ack2?.matched === false && !o.ack2?.refusedForNoAnswer, { late: o.late2.length, ack2: o.ack2 });
    check('L7 GET /api/lane-incidents/late-answers counts it: refused ≥ 1, lateAnswers 1, lateApproved 1, deadlineMs echoes the config',
      o.countStatus === 200 && o.count?.lateAnswers === 1 && o.count?.lateApproved === 1 && o.count?.refused >= 1 && o.count?.deadlineMs === 20_000 && o.count?.windowDays === 1, o.count);
    check('L8 the per-project count matches; a bad window (days=0) is a 400', o.projCount?.lateAnswers === 1 && o.bad === 400, { projCount: o.projCount, bad: o.bad });
    check('L9 the Needs-You rail shows the refusal but NO late-answer card', o.needs.some((id) => String(id).startsWith('lane-incident-permission-expired')) && !o.needs.some((id) => String(id).includes('late-answer')), o.needs);
    if (fail) L.setKeep?.(true);
  }

  console.log('M  MUST-FAIL: the same arm on a constructed mutant whose answer paths never record a late answer');
  let mroot = null;
  try {
    mroot = buildMutantTree({ prefix: 'late-ans-mutant-', copy: ['src'], edits: [{ file: 'src/server/agent-bridge.ts', from: 'if (!p) this.#noteLateAnswer(', to: 'if (false) this.#noteLateAnswer(', count: 3 }] });
    const M = await withAttempts(mroot, 'm', 3);
    check('M0 PRECONDITION: the mutant arm raised a lane card', M.valid, M.why);
    if (M.valid) {
      const recorded = M.obs.late1.length === 1 && M.obs.late1[0].answer === 'approved';
      // Only the RECORDING is mutated (the ack flag is read separately in index.ts), so grade the record + count.
      check('M1 on the mutant the late-answer property FAILS (no record, the count stays 0) — the proof is not vacuous',
        !recorded && (M.obs.count?.lateAnswers ?? 0) === 0, { late: M.obs.late1.length, ack: M.obs.ack, count: M.obs.count });
      check('M2 …while the mutant still refused the card at the deadline (only the late-answer record differs)', !!M.obs.refused, M.obs.refused ?? 'none');
    }
  } finally { if (mroot && !KEEP) fs.rmSync(mroot, { recursive: true, force: true }); }
}

console.log(`\nTOTAL: ${pass} passed, ${fail} failed${failures.length ? `\nFAILED:\n  - ${failures.join('\n  - ')}` : ''}`);
process.exit(fail ? 1 : 0);
