/**
 * Live verification for interactive decisions and mid-session permission mode.
 *
 *   npm run verify:decisions
 *
 * Everything here is driven through the REAL server over the REAL WebSocket, by
 * a REAL model session (haiku — the cheapest model that reliably triggers the
 * behaviour). Nothing is stubbed, because the whole question is what the CLI and
 * the model actually do.
 *
 * Design rules (docs/prompts/WORKING_AGREEMENT.v2.md §C):
 *  - every check prints the value it observed
 *  - each behavioural claim is asserted against the MODEL'S OWN OUTPUT, not
 *    against the fact that we managed to send something
 *  - a check that could pass on empty input asserts its precondition first
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
/* Never a fixed port: two suites defaulting to the same number collide the
   moment both run (observed: verify-ui + verify-sessions on 4319). The OS
   hands out a free one; the env var still pins it when a run needs to. */
async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const PORT = Number(process.env.VERIFY_DECISIONS_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-dec-data-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-dec-work-'));
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-dec-store-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const failures = [];
const check = (name, ok, observed) => {
  const line = typeof observed === 'string' ? observed : JSON.stringify(observed);
  if (ok) { pass++; console.log(`  PASS  ${name}\n        observed: ${line}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}\n        observed: ${line}`); }
};
const section = (t) => console.log(`\n=== ${t} ===`);

async function post(p, payload, method = 'POST') {
  const res = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const body = await res.json();
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

/** A socket plus its full event log; every assertion reads from the log. */
function openWs() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const events = [];
  ws.on('message', (m) => { try { events.push(JSON.parse(String(m))); } catch { /* ignore */ } });
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, events, send: (o) => ws.send(JSON.stringify(o)) }));
    ws.once('error', reject);
  });
}

/*
 * `from` is an INDEX, never a sliced copy. A slice is a snapshot that stops
 * growing, so polling it can only ever see events that had already arrived —
 * which silently turns "wait for the next X" into "time out". (It did exactly
 * that here before this was fixed.)
 */
const waitFor = async (events, pred, ms, what, from = 0) => {
  const t0 = Date.now();
  for (;;) {
    const hit = events.slice(from).find(pred);
    if (hit) return hit;
    if (Date.now() - t0 > ms) throw new Error(`timed out after ${ms}ms waiting for ${what}`);
    await sleep(120);
  }
};
/** Resolves on the NEXT turn-end after `from` (index into the log). */
const waitTurn = async (events, from, ms = 180_000) => {
  const t0 = Date.now();
  for (;;) {
    for (let i = from; i < events.length; i++) if (events[i].t === 'turn-end') return i;
    if (Date.now() - t0 > ms) throw new Error(`timed out after ${ms}ms waiting for turn-end`);
    await sleep(150);
  }
};
const textSince = (events, from) =>
  events.slice(from).filter((e) => e.t === 'text').map((e) => e.text).join('\n');

/**
 * Auto-allow every generic approval this socket receives.
 *
 * Needed because approving an ExitPlanMode plan LEAVES plan mode — the very next
 * edit then raises a normal permission prompt. Without this the harness sits on
 * it forever and reports a timeout that looks like a product bug (it did).
 * Only touches `approval-request`; decisions are still answered explicitly.
 */
function autoAllowApprovals(sock) {
  const seen = new Set();
  const timer = setInterval(() => {
    for (const e of sock.events) {
      if (e.t !== 'approval-request' || seen.has(e.requestId)) continue;
      seen.add(e.requestId);
      sock.send({ type: 'approval-response', requestId: e.requestId, allow: true });
    }
  }, 200);
  timer.unref?.();
  return () => clearInterval(timer);
}

/*
 * Section gates. Every section is independent, so a re-run after a fix does not
 * have to pay for the live turns that already passed.
 *   DEC_ONLY=plan npm run verify:decisions
 */
const ONLY = (process.env.DEC_ONLY ?? 'questions,plan,perm').split(',').map((s) => s.trim());
const RUN_Q = ONLY.includes('questions');
const RUN_PLAN = ONLY.includes('plan');
const RUN_PERM = ONLY.includes('perm');


let server;
const sockets = [];
/** Files the model wrote outside our scratch dirs; swept in `finally`. */
const strays = [];

try {
  server = spawn(process.execPath, [path.join(ROOT, 'src/server/index.ts')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  for (let i = 0; i < 80; i++) { try { await fetch(`${BASE}/api/health`); break; } catch { await sleep(250); } }

  const project = (await post('/api/projects', { hostPath: WORK, name: 'Decisions' })).project;
  await post(`/api/projects/${project.id}`, { model: 'haiku', permissionMode: 'default' }, 'PATCH');

  if (RUN_Q) {
  /* ================================================================== 1 */
  section('1. AskUserQuestion surfaces as a typed question-request');

  const A = await openWs(); sockets.push(A);
  A.send({
    type: 'start',
    projectId: project.id,
    prompt:
      'Use the AskUserQuestion tool right now to ask me which colour to paint the shed. ' +
      'Offer exactly two options: "Crimson" (a deep red) and "Emerald" (a rich green). ' +
      'Do nothing else first. After you have my answer, reply with exactly: FINAL CHOICE = <the label I picked>.',
  });
  await waitFor(A.events, (e) => e.t === 'ack' && e.of === 'start', 120_000, 'start ack');

  const q1 = await waitFor(A.events, (e) => e.t === 'question-request', 180_000, 'question-request');
  check(
    'the question arrives as its own typed event, not a generic approval-request',
    q1.t === 'question-request' && !A.events.some((e) => e.t === 'approval-request' && e.toolName === 'AskUserQuestion'),
    `events so far: ${[...new Set(A.events.map((e) => e.t))].join(', ')}`,
  );

  const spec = q1.questions?.[0];
  check(
    'PRECONDITION: the event carries a structured question with >= 2 labelled options',
    Array.isArray(q1.questions) && q1.questions.length >= 1 && !!spec && spec.options?.length >= 2,
    `questions=${q1.questions?.length}, options=${JSON.stringify(spec?.options?.map((o) => o.label))}`,
  );
  if (!spec || spec.options.length < 2) throw new Error('precondition failed — cannot continue without a parsed question');

  check(
    'options keep label AND description separately (not flattened to a string)',
    spec.options.every((o) => typeof o.label === 'string' && o.label.length > 0 && typeof o.description === 'string'),
    JSON.stringify(spec.options.map((o) => ({ label: o.label, description: o.description.slice(0, 40) }))),
  );
  check(
    'question text, header chip and multiSelect flag all present',
    typeof spec.question === 'string' && spec.question.length > 0 && typeof spec.header === 'string' && typeof spec.multiSelect === 'boolean',
    `question=${JSON.stringify(spec.question)}, header=${JSON.stringify(spec.header)}, multiSelect=${spec.multiSelect}`,
  );
  check(
    'requestId (answer key) and toolUseId (matches the tool-call card) are both carried',
    typeof q1.requestId === 'string' && q1.requestId.length > 0 &&
      A.events.some((e) => e.t === 'tool-call' && e.name === 'AskUserQuestion' && e.toolUseId === q1.toolUseId),
    `requestId=${q1.requestId}, toolUseId=${q1.toolUseId}`,
  );

  /* ================================================================== 2 */
  section('2. answers are matched BY ID, and only through the right channel');

  A.send({ type: 'question-response', requestId: 'no-such-request-id', answers: [{ question: spec.question, selected: [spec.options[0].label] }] });
  const stale = await waitFor(A.events, (e) => e.t === 'ack' && e.of === 'question-response' && e.requestId === 'no-such-request-id', 10_000, 'stale ack');
  check('an answer for an unknown/stale requestId is refused, not applied to the pending one',
    stale.matched === false, JSON.stringify(stale));

  A.send({ type: 'approval-response', requestId: q1.requestId, allow: true });
  const wrongCh = await waitFor(A.events, (e) => e.t === 'ack' && e.of === 'approval-response' && e.requestId === q1.requestId, 10_000, 'approval ack');
  check('a question CANNOT be settled through the generic approval channel (an "Allow" would send no answer)',
    wrongCh.matched === false, JSON.stringify(wrongCh));

  // Deliberately the SECOND option: the first is what a guess would pick.
  const chosen = spec.options[1].label;
  const notChosen = spec.options[0].label;
  const beforeAnswer = A.events.length;
  A.send({ type: 'question-response', requestId: q1.requestId, answers: [{ question: spec.question, header: spec.header, selected: [chosen], other: null }] });
  const ack1 = await waitFor(A.events, (e) => e.t === 'ack' && e.of === 'question-response' && e.requestId === q1.requestId, 15_000, 'answer ack');
  check('the server acks the answer by requestId, and reports it as a real answer',
    ack1.matched === true && ack1.answered === true, JSON.stringify(ack1));

  A.send({ type: 'question-response', requestId: q1.requestId, answers: [{ question: spec.question, selected: [notChosen] }] });
  const dup = await waitFor(A.events, (e) => e.t === 'ack' && e.of === 'question-response' && e.requestId === q1.requestId && e !== ack1, 10_000, 'duplicate ack');
  check('a second answer for an ALREADY RESOLVED question is refused (no double-settle)',
    dup.matched === false, JSON.stringify(dup));

  /* ================================================================== 3 */
  section('3. LOAD-BEARING: the model RECEIVED the answer (its output reflects it)');

  const end1 = await waitTurn(A.events, beforeAnswer);
  const toolRes = A.events.slice(beforeAnswer, end1 + 1).find((e) => e.t === 'tool-result' && e.toolUseId === q1.toolUseId);
  check(
    'the AskUserQuestion tool_result the MODEL saw contains the chosen label — not "did not answer"',
    !!toolRes && toolRes.preview.includes(chosen) && !/did not answer/i.test(toolRes.preview),
    `tool_result=${JSON.stringify(toolRes?.preview?.slice(0, 200))}`,
  );
  const said = textSince(A.events, beforeAnswer);
  check(
    `the model's subsequent output names the chosen option (${chosen}) and not the other (${notChosen})`,
    said.includes(chosen) && !said.includes(notChosen),
    JSON.stringify(said.trim().slice(-200)),
  );

  /* ================================================================== 3b */
  section('3b. two questions in flight at once: the SECOND is answered, by key, not by order');
  /*
   * `AskUserQuestion` carries 1-4 questions per call, and the CLI keys answers
   * by the exact question TEXT. So this answers only the second of two pending
   * questions and asserts the model got that one and only that one — an
   * order-based (FIFO) implementation would have answered the first.
   */
  const beforeMulti = A.events.length;
  A.send({
    type: 'send',
    prompt:
      'Use the AskUserQuestion tool ONCE with exactly TWO questions in the same call. ' +
      'Q1: which wood — "Cedar" or "Pine". Q2: which roof — "Slate" or "Tin". ' +
      'Then reply with exactly two lines: "WOOD = <answer or NONE>" and "ROOF = <answer or NONE>".',
  });
  const qm = await waitFor(A.events, (e) => e.t === 'question-request', 180_000, 'multi question-request', beforeMulti);
  const twoUp = (qm.questions ?? []).length >= 2;
  check('PRECONDITION: two distinct questions are pending in one request', twoUp,
    `questions=${JSON.stringify((qm.questions ?? []).map((q) => q.question))}`);
  if (twoUp) {
    const second = qm.questions[1];
    const first = qm.questions[0];
    const pick = second.options[1]?.label ?? second.options[0].label;
    A.send({ type: 'question-response', requestId: qm.requestId, answers: [{ question: second.question, selected: [pick] }] });
    const ackM = await waitFor(A.events, (e) => e.t === 'ack' && e.of === 'question-response' && e.requestId === qm.requestId, 15_000, 'multi ack');
    check('acked as a real answer even though only one of the two was answered', ackM.matched === true && ackM.answered === true, JSON.stringify(ackM));
    const endM = await waitTurn(A.events, beforeMulti);
    const resM = A.events.slice(beforeMulti, endM + 1).find((e) => e.t === 'tool-result' && e.toolUseId === qm.toolUseId);
    check(
      `LOAD-BEARING: the model's tool_result carries the SECOND question's answer (${pick}) keyed to it, and no answer for the first`,
      !!resM && resM.preview.includes(pick) && resM.preview.includes(second.question) && !resM.preview.includes(first.question),
      `tool_result=${JSON.stringify(resM?.preview?.slice(0, 240))}`,
    );
  }

  /* ================================================================== 4 */
  section('4. the no-answer path still works, and is distinguishable from answered');

  const before2 = A.events.length;
  A.send({
    type: 'send',
    prompt:
      'Now use the AskUserQuestion tool again to ask which wood to use: "Cedar" or "Pine". ' +
      'If I do not answer, say exactly: NO ANSWER RECEIVED.',
  });
  const q2 = await waitFor(A.events, (e) => e.t === 'question-request', 180_000, 'second question-request', before2);
  check('PRECONDITION: a second, distinct question is pending', q2.requestId !== q1.requestId, `requestId=${q2.requestId}`);

  A.send({ type: 'question-response', requestId: q2.requestId, answers: [] });
  const ack2 = await waitFor(A.events, (e) => e.t === 'ack' && e.of === 'question-response' && e.requestId === q2.requestId, 15_000, 'pass ack');
  check(
    'passing acks matched:true but answered:FALSE — the UI can tell "carried on" from "answered"',
    ack2.matched === true && ack2.answered === false,
    JSON.stringify(ack2),
  );
  const end2 = await waitTurn(A.events, before2);
  const toolRes2 = A.events.slice(before2, end2 + 1).find((e) => e.t === 'tool-result' && e.toolUseId === q2.toolUseId);
  check(
    'with no answer the model sees the pre-existing "did not answer" result and proceeds (behaviour preserved)',
    !!toolRes2 && /did not answer/i.test(toolRes2.preview),
    `tool_result=${JSON.stringify(toolRes2?.preview?.slice(0, 160))}`,
  );

  /* ================================================================== 5 */
  section('5. a question pending when the session ends does not wedge it');

  const before3 = A.events.length;
  A.send({ type: 'send', prompt: 'Use AskUserQuestion to ask whether to paint the door "Black" or "White".' });
  const q3 = await waitFor(A.events, (e) => e.t === 'question-request', 180_000, 'third question-request', before3);
  A.send({ type: 'close' });
  const closed = await waitFor(A.events, (e) => e.t === 'session-closed', 30_000, 'session-closed');
  check(
    'closing with a question pending resolves it and closes cleanly (no hang)',
    !!closed && !!q3.requestId,
    `pending requestId=${q3.requestId}; session-closed reason=${JSON.stringify(closed.reason)}`,
  );
  A.ws.close();
  }

  if (RUN_PLAN) {
  /* ================================================================== 6 */
  section('6. ExitPlanMode shares the channel: plan-request -> approval -> the model proceeds');

  fs.writeFileSync(path.join(WORK, 'shed.txt'), 'colour: unpainted\n');
  const B = await openWs(); sockets.push(B);
  // Approving the plan drops the session back to `default`, so the edit that
  // follows raises a normal prompt. Answer those automatically; the plan itself
  // is still answered explicitly below.
  const stopAutoAllow = autoAllowApprovals(B);
  B.send({
    type: 'start',
    projectId: project.id,
    overrides: { permissionMode: 'plan' },
    prompt:
      `Write a one-sentence plan to change the colour line in the file ${path.join(WORK, 'shed.txt')} to "emerald", ` +
      'then call ExitPlanMode to get my approval. Once approved, make that exact edit to that exact file ' +
      'and reply with exactly: PLAN APPROVED.',
  });
  await waitFor(B.events, (e) => e.t === 'ack' && e.of === 'start', 120_000, 'start ack');
  const plan = await waitFor(B.events, (e) => e.t === 'plan-request', 240_000, 'plan-request');
  check(
    'ExitPlanMode surfaces as its own typed plan-request carrying the plan text',
    typeof plan.plan === 'string' && plan.plan.length > 0 && typeof plan.requestId === 'string',
    `requestId=${plan.requestId}, plan=${JSON.stringify(plan.plan.slice(0, 120))}`,
  );
  check('a plan CANNOT be settled by a question-response (wrong kind, matched:false)',
    (B.send({ type: 'question-response', requestId: plan.requestId, answers: [] }),
      (await waitFor(B.events, (e) => e.t === 'ack' && e.of === 'question-response' && e.requestId === plan.requestId, 10_000, 'kind ack')).matched === false),
    'question-response against a plan-request');

  const beforePlan = B.events.length;
  B.send({ type: 'plan-response', requestId: plan.requestId, approved: true });
  const ackPlan = await waitFor(B.events, (e) => e.t === 'ack' && e.of === 'plan-response' && e.requestId === plan.requestId, 15_000, 'plan ack');
  check('the plan approval is acked by requestId', ackPlan.matched === true && ackPlan.approved === true, JSON.stringify(ackPlan));

  const endPlan = await waitTurn(B.events, beforePlan, 240_000);
  const planRes = B.events.slice(beforePlan, endPlan + 1).find((e) => e.t === 'tool-result' && e.toolUseId === plan.toolUseId);
  check(
    'LOAD-BEARING: the approval reached the MODEL — its tool_result is "User has approved your plan", not a rejection or an unanswered prompt',
    !!planRes && /approved your plan/i.test(planRes.preview),
    `tool_result=${JSON.stringify(planRes?.preview?.slice(0, 120))}`,
  );
  /*
   * Deliberately a SEPARATE check. Whether the model then does the edit in the
   * same turn is model behaviour, not an approval-plumbing fact — folding the
   * two together made a passing mechanism report as a failure once already.
   * What is load-bearing is that plan mode is genuinely LEFT: in plan mode a
   * mutating tool cannot even be attempted.
   */
  let mutated = B.events
    .slice(beforePlan, endPlan + 1)
    .some((e) => e.t === 'tool-call' && (e.name === 'Edit' || e.name === 'Write'));
  if (!mutated) {
    // The model does not always act in the same turn it was approved in — that
    // is its own diligence, not our plumbing. Ask again explicitly so the check
    // measures the thing it claims to: whether mutation is now POSSIBLE.
    const beforeGo = B.events.length;
    B.send({ type: 'send', prompt: `Proceed with the approved plan now: edit ${path.join(WORK, 'shed.txt')} so its colour line reads "emerald".` });
    const endGo = await waitTurn(B.events, beforeGo, 240_000);
    mutated = B.events.slice(beforeGo, endGo + 1).some((e) => e.t === 'tool-call' && (e.name === 'Edit' || e.name === 'Write'));
  }
  const shed = fs.readFileSync(path.join(WORK, 'shed.txt'), 'utf8');
  check(
    'after approval the session can actually mutate — a tool that plan mode forbids now runs, so the approval really unlocked it',
    mutated && shed.includes('emerald'),
    `mutating tool-call after approval=${mutated}; shed.txt=${JSON.stringify(shed.trim())}`,
  );
  const modeEv = B.events.slice(beforePlan).find((e) => e.t === 'permission-mode');
  check(
    'approving a plan leaves plan mode, and the server reports the change rather than letting the UI keep showing "plan"',
    !!modeEv && modeEv.mode !== 'plan' && modeEv.source === 'agent',
    JSON.stringify(modeEv ?? null),
  );
  stopAutoAllow();
  B.send({ type: 'close' });
  await waitFor(B.events, (e) => e.t === 'session-closed', 30_000, 'session-closed');
  B.ws.close();
  }

  if (RUN_PERM) {
  /* ================================================================== 7 */
  section('7. mid-session permission mode: arming alone changes nothing');

  const C = await openWs(); sockets.push(C);
  C.send({ type: 'start', projectId: project.id, prompt: `Use the Write tool to create the file ${path.join(WORK, 'a.txt')} containing exactly: alpha. Then say DONE1.` });
  await waitFor(C.events, (e) => e.t === 'ack' && e.of === 'start', 120_000, 'start ack');
  const cfg = await waitFor(C.events, (e) => e.t === 'effective-config', 30_000, 'effective-config');
  check('PRECONDITION: this session started in "default" mode (so any skipped prompt below is the mode change, not the start)',
    cfg.effective.permissionMode === 'default', `permissionMode=${cfg.effective.permissionMode}, source=${cfg.permissionModeSource}`);

  const ask1 = await waitFor(C.events, (e) => e.t === 'approval-request' && e.toolName === 'Write', 240_000, 'first Write approval');
  check(
    'ARMING IS NOT ENGAGING: with allowDangerouslySkipPermissions always set, a default-mode Write STILL prompts',
    ask1.toolName === 'Write', `approval-request for ${ask1.toolName}, input.file_path=${JSON.stringify(ask1.input?.file_path)}`,
  );
  if (typeof ask1.input?.file_path === 'string' && !ask1.input.file_path.startsWith(WORK)) strays.push(ask1.input.file_path);
  C.send({ type: 'approval-response', requestId: ask1.requestId, allow: true });
  const t1 = await waitTurn(C.events, 0, 240_000);

  section('8. LOAD-BEARING: switching to bypass mid-session actually stops the prompts');
  C.send({ type: 'set-permission-mode', requestId: 'pm-1', mode: 'bypassPermissions' });
  const pmAck = await waitFor(C.events, (e) => e.t === 'ack' && e.of === 'set-permission-mode' && e.requestId === 'pm-1', 20_000, 'mode ack');
  check('set-permission-mode(bypassPermissions) is accepted by the CLI on a running session',
    pmAck.ok === true && !pmAck.error, JSON.stringify(pmAck));
  const pmEv = C.events.slice(t1).find((e) => e.t === 'permission-mode' && e.source === 'client');
  check('the confirmed change is broadcast as a typed event and re-reported in effective-config',
    !!pmEv && pmEv.mode === 'bypassPermissions' &&
      C.events.slice(t1).some((e) => e.t === 'effective-config' && e.effective.permissionMode === 'bypassPermissions' && e.permissionModeSource === 'live-change'),
    JSON.stringify(pmEv ?? null));

  const before8 = C.events.length;
  C.send({ type: 'send', prompt: `Use the Write tool to create the file ${path.join(WORK, 'b.txt')} containing exactly: bravo. Then say DONE2.` });
  const t2 = await waitTurn(C.events, before8, 240_000);
  /*
   * The precondition reads the path the model ACTUALLY used rather than the one
   * we hoped for — an earlier version asserted `WORK/b.txt` while the model had
   * written elsewhere, which reported a working feature as broken.
   */
  const writeCall = C.events.slice(before8, t2 + 1).find((e) => e.t === 'tool-call' && e.name === 'Write');
  const writtenPath = String(writeCall?.input?.file_path ?? '');
  const landed = !!writtenPath && fs.existsSync(writtenPath);
  const asks8 = C.events.slice(before8, t2 + 1).filter((e) => e.t === 'approval-request');
  check('PRECONDITION: the turn really did run a Write, and it landed on disk (so "no prompts" is not just "nothing happened")',
    !!writeCall && landed, `Write tool-call=${!!writeCall}, file_path=${JSON.stringify(writtenPath)}, exists=${landed}`);
  if (writtenPath.startsWith(os.tmpdir()) && !writtenPath.startsWith(WORK)) strays.push(writtenPath);
  check('ZERO approval requests during that Write — the live mode change genuinely took effect',
    asks8.length === 0, `${asks8.length} approval-request event(s): ${JSON.stringify(asks8.map((a) => a.toolName))}`);

  section('9. switching back restores the prompts');
  C.send({ type: 'set-permission-mode', requestId: 'pm-2', mode: 'default' });
  const pmAck2 = await waitFor(C.events, (e) => e.t === 'ack' && e.of === 'set-permission-mode' && e.requestId === 'pm-2', 20_000, 'mode ack 2');
  check('set-permission-mode(default) is accepted', pmAck2.ok === true, JSON.stringify(pmAck2));

  const before9 = C.events.length;
  C.send({ type: 'send', prompt: `Use the Write tool to create the file ${path.join(WORK, 'c.txt')} containing exactly: charlie. Then say DONE3.` });
  const ask3 = await waitFor(C.events, (e) => e.t === 'approval-request' && e.toolName === 'Write', 240_000, 'third Write approval', before9);
  check('the approval prompt returns after switching back to default', ask3.toolName === 'Write',
    `approval-request for ${ask3.toolName}, file=${JSON.stringify(ask3.input?.file_path)}`);
  if (typeof ask3.input?.file_path === 'string' && !ask3.input.file_path.startsWith(WORK)) strays.push(ask3.input.file_path);
  C.send({ type: 'approval-response', requestId: ask3.requestId, allow: true });
  await waitTurn(C.events, before9, 240_000);

  section('10. a mode the CLI refuses is reported honestly, never as a silent success');
  C.send({ type: 'set-permission-mode', requestId: 'pm-3', mode: 'nonsense' });
  const bad = await waitFor(C.events, (e) => e.t === 'ack' && e.of === 'set-permission-mode' && e.requestId === 'pm-3', 15_000, 'bad mode ack');
  check('an invalid mode is rejected with a specific error and ok:false', bad.ok === false && /must be one of/.test(String(bad.error)), JSON.stringify(bad));

  C.send({ type: 'close' });
  await waitFor(C.events, (e) => e.t === 'session-closed', 30_000, 'session-closed');
  C.ws.close();
  }
} catch (err) {
  fail++;
  failures.push(`harness error: ${err.message}`);
  console.error(`\n  HARNESS ERROR: ${err.stack ?? err.message}`);
} finally {
  for (const s of sockets) { try { s.ws.close(); } catch { /* already gone */ } }
  await sleep(500);
  try { server?.kill('SIGTERM'); } catch { /* already gone */ }
  await sleep(500);
  try { server?.kill('SIGKILL'); } catch { /* already gone */ }
  for (const d of [DATA, WORK, STORE]) fs.rmSync(d, { recursive: true, force: true });
  // The model sometimes ignores the path we asked for; never leave its files behind.
  for (const f of strays) { try { fs.rmSync(f, { force: true }); } catch { /* gone */ } }
}

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) { console.log(`failed: ${failures.join(' | ')}`); process.exit(1); }
