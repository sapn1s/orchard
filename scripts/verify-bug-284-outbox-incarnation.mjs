#!/usr/bin/env node
/**
 * BUG-284 — a queued message is never resumed into a DIFFERENT project that took its project's id.
 *
 * In-process, on the REAL outbox (src/server/outbox.ts) and the REAL registry (src/server/registry.ts) in a scratch
 * CLAUDE_STATION_DATA. The wiring is the fake CLI of the BUG-217 harness plus `projectIdentity` exactly as index.ts
 * builds it (reg.getProject + reg.incarnationOf). A "restart" is a fresh module instance on the same data dir.
 * Projects are created, deleted, re-added, renamed, repointed and scratch-re-ensured with the registry's own functions.
 *
 *   node scripts/verify-bug-284-outbox-incarnation.mjs [--tree <dir>]
 *
 * `--tree <dir>` loads outbox.ts from another checkout (must-FAIL baseline: the pre-BUG-284 tree). The wiring then
 * still offers projectIdentity, which an old outbox simply never calls.
 *
 * Properties:
 *   S1  a row is stamped with the project's incarnation at enqueue (createOutboxRow); a caller-named one is kept
 *   R1  delete + re-add under the same id while a row is held → NOT resumed into the new project; failed with a reason
 *   R2  the same with a server restart between the delete + re-add and the hold clearing
 *   R3  project deleted and not re-added → failed, never handed over
 *   R4  rename and repoint keep the incarnation → delivered (an ordinary project edit must never strand a message)
 *   R5  FEAT-200 r12: a route into an ALREADY running session of a RE-ADDED project → NOT delivered; failed (the
 *       incarnation chokepoint runs before the route split, so the running route no longer bypasses it)
 *   R5b a route into an ALREADY running session of the SAME intact project → delivered (criterion 5 preserved)
 *   R6  scratch: delete + re-ensure (a new incarnation under the id 'scratch') → not resumed
 *   R7  a start row (a new session's first message, mintStartRow) → not started inside a re-added project
 *   R8  a caller-named incarnation (FEAT-200: the request's own) that is already gone → not resumed
 *   L1  legacy row (no stamp) + a project row older than it → delivered
 *   L2  legacy row (no stamp) + a project row created after it (re-added) → not resumed
 *   U1  registry unreadable → it waits (never fails, never sends); once readable → delivered
 *   B1  one batch, mixed: only the row of the removed incarnation fails, the current one is delivered
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadOutbox, settle, makeCtl } from './fixtures/bug-217/outbox-harness.mjs';

const REPO = path.resolve(import.meta.dirname, '..');
const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const TREE = arg('--tree') ? path.resolve(arg('--tree')) : REPO;
const OUTBOX = path.join(TREE, 'src', 'server', 'outbox.ts');

let pass = 0, fail = 0; const fails = [];
function check(name, ok, obs) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      observed: ${typeof obs === 'string' ? obs : JSON.stringify(obs)}`);
  if (ok) pass++; else { fail++; fails.push(name); }
}

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bug284-data-'));
process.env.CLAUDE_STATION_DATA = DATA;
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'bug284-scratch-'));
process.env.CLAUDE_STATION_SCRATCH_DIR = SCRATCH;
const reg = await import(pathToFileURL(path.join(REPO, 'src', 'server', 'registry.ts')).href);
// The data-dir lock is taken through the SAME lanes.ts the outbox under test imports (its tree's).
const lock = await (await import(pathToFileURL(path.join(TREE, 'src', 'server', 'lanes.ts')).href)).claimWriter();
if (!lock.ok) { console.error(`could not take the data dir lock: ${lock.reason}`); process.exit(2); }

const quiet = () => { const s = { log: console.log, error: console.error }; const logs = []; console.log = (...a) => logs.push(a.join(' ')); console.error = (...a) => logs.push(a.join(' ')); return { logs, restore: () => Object.assign(console, s) }; };
const projDir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `bug284-p-${tag}-`));
const newProject = (name, dir = projDir(name)) => reg.createProject({ name, hostPath: dir, isolation: 'host', settings: { tools: { playwright: false, serena: false, openaiDispatch: false } } });
const readd = (p) => { reg.deleteProject(p.id); const q = newProject(p.name, p.hostPath); if (q.id !== p.id) throw new Error(`re-add got id ${q.id}, not ${p.id}`); return q; };

/** A world: one outbox module instance + a fake CLI whose probe goes to `route`. */
let m = null; let ctl = null;
let identityThrows = false;
async function boot({ route = 'resume', running = false } = {}) {
  try { m?.stopOutbox(); } catch { /* */ }
  ctl = makeCtl();
  ctl.wiring.probe = () => (ctl.go ? { kind: 'go', route, ...(running ? { running: true } : {}) } : { kind: 'wait', hold: { kind: 'external', text: 'another program is writing this session' } });
  ctl.wiring.projectIdentity = (id) => {
    if (identityThrows) throw new Error('registry: not valid JSON');
    const p = reg.getProject(id);
    return p ? { incarnation: reg.incarnationOf(p), createdAt: Date.parse(p.createdAt) } : null;
  };
  m = await loadOutbox(OUTBOX);
  m.startOutbox(ctl.wiring);
  await settle();
}
const sidOf = () => `b284s${crypto.randomBytes(4).toString('hex')}`;
const resumeOf = (p, extra = {}) => ({ projectId: p.id, encodedDir: null, overrides: null, templateIds: null, ...extra });
const enqueue = (sid, p, text, extra = {}) => m.createOutboxRow(sid, { nonce: `n-${crypto.randomBytes(6).toString('hex')}`, text, origin: 'direct', resume: resumeOf(p, extra) }).row;
async function release(sid) { ctl.go = true; m.nudgeOutbox(sid); await settle(6); await new Promise((r) => setTimeout(r, 40)); await settle(4); }
const gotText = (t) => ctl.prompts.filter((x) => x.includes(t)).length;
const rowNow = (sid, id) => m.outboxRow(sid, id);

const q = quiet();
try {
  /* S1 — stamping */
  await boot();
  const P1 = newProject('b284-s1');
  const s1 = sidOf();
  const r1 = enqueue(s1, P1, 'S1-text');
  const r1b = enqueue(s1, P1, 'S1b-text', { projectIncarnation: 'inc-named-by-caller' });
  q.restore(); check('S1 a row is stamped with the project\'s incarnation at enqueue; a caller-named incarnation is kept', r1.resume.projectIncarnation === reg.incarnationOf(P1) && r1b.resume.projectIncarnation === 'inc-named-by-caller', { stamped: r1.resume.projectIncarnation ?? null, want: reg.incarnationOf(P1), named: r1b.resume.projectIncarnation ?? null }); Object.assign(q, quiet());

  /* R1 — delete + re-add while held */
  await boot();
  const PA = newProject('b284-r1');
  const sA = sidOf();
  const rA = enqueue(sA, PA, 'R1-granted-text');
  const PA2 = readd(PA);
  await release(sA);
  const stA = rowNow(sA, rA.id);
  q.restore(); check('R1 delete + re-add (same id) while held → NOT resumed into the re-added project; the row fails with the reason', gotText('R1-granted-text') === 0 && stA?.state === 'failed' && /removed from Orchard/.test(stA?.reason ?? '') && PA2.incarnation !== PA.incarnation, { handedOver: gotText('R1-granted-text'), state: stA?.state, reason: (stA?.reason ?? '').slice(0, 90) }); Object.assign(q, quiet());

  /* R2 — restart between */
  await boot();
  const PB = newProject('b284-r2');
  const sB = sidOf();
  const rB = enqueue(sB, PB, 'R2-text');
  m.stopOutbox();
  readd(PB);
  await boot();
  await release(sB);
  const stB = rowNow(sB, rB.id);
  q.restore(); check('R2 the same with a restart between the re-add and the hold clearing → not resumed, failed', gotText('R2-text') === 0 && stB?.state === 'failed', { handedOver: gotText('R2-text'), state: stB?.state }); Object.assign(q, quiet());

  /* R3 — deleted, not re-added */
  await boot();
  const PC = newProject('b284-r3');
  const sC = sidOf();
  const rC = enqueue(sC, PC, 'R3-text');
  reg.deleteProject(PC.id);
  await release(sC);
  const stC = rowNow(sC, rC.id);
  q.restore(); check('R3 project deleted (not re-added) → never handed over; failed', gotText('R3-text') === 0 && stC?.state === 'failed', { handedOver: gotText('R3-text'), state: stC?.state }); Object.assign(q, quiet());

  /* R4 — rename + repoint keep the incarnation */
  await boot();
  const PD = newProject('b284-r4');
  const sD = sidOf();
  const rD = enqueue(sD, PD, 'R4-text');
  reg.updateProject(PD.id, { name: 'b284-r4-renamed' });
  reg.updateProject(PD.id, { hostPath: projDir('r4b') });
  const PDn = reg.getProject(PD.id);
  await release(sD);
  const stD = rowNow(sD, rD.id);
  q.restore(); check('R4 rename + repoint keep the incarnation → delivered exactly once', gotText('R4-text') === 1 && stD?.state === 'delivered' && reg.incarnationOf(PDn) === reg.incarnationOf(PD) && PDn.name === 'b284-r4-renamed', { handedOver: gotText('R4-text'), state: stD?.state, sameInc: reg.incarnationOf(PDn) === reg.incarnationOf(PD), name: PDn?.name }); Object.assign(q, quiet());

  /* R5 — FEAT-200 r12: a running session of a RE-ADDED project must NOT get it (one chokepoint, running route checked too) */
  await boot({ route: 'bridge', running: true });
  const PE = newProject('b284-r5');
  const sE = sidOf();
  const rE = enqueue(sE, PE, 'R5-text');
  readd(PE);
  await release(sE);
  const stE = rowNow(sE, rE.id);
  q.restore(); check('R5 into an ALREADY running session (running: true) after a re-add → NOT delivered; failed (running route no longer bypasses the incarnation check)', gotText('R5-text') === 0 && stE?.state === 'failed', { handedOver: gotText('R5-text'), state: stE?.state, reason: stE?.reason?.slice(0, 60) }); Object.assign(q, quiet());

  /* R5b — anti-regression: a running session of the SAME intact project still gets it (criterion 5) */
  await boot({ route: 'bridge', running: true });
  const PEb = newProject('b284-r5b');
  const sEb = sidOf();
  const rEb = enqueue(sEb, PEb, 'R5b-text');
  await release(sEb);
  const stEb = rowNow(sEb, rEb.id);
  q.restore(); check('R5b into an ALREADY running session (running: true), project intact → delivered (criterion 5 preserved)', gotText('R5b-text') === 1 && stEb?.state === 'delivered', { handedOver: gotText('R5b-text'), state: stEb?.state }); Object.assign(q, quiet());

  /* R6 — scratch re-ensure */
  await boot();
  reg.deleteProject('scratch');
  const SC1 = reg.ensureScratchProject();
  const sF = sidOf();
  const rF = enqueue(sF, SC1, 'R6-text');
  reg.deleteProject('scratch');
  const SC2 = reg.ensureScratchProject();
  await release(sF);
  const stF = rowNow(sF, rF.id);
  q.restore(); check('R6 scratch delete + re-ensure (new incarnation under id "scratch") → not resumed; failed', SC1.id === 'scratch' && SC2.id === 'scratch' && reg.incarnationOf(SC1) !== reg.incarnationOf(SC2) && gotText('R6-text') === 0 && stF?.state === 'failed', { handedOver: gotText('R6-text'), state: stF?.state }); Object.assign(q, quiet());

  /* R7 — start row */
  await boot({ route: 'new' });
  const PG = newProject('b284-r7');
  const st = m.mintStartRow({ projectId: PG.id, text: 'R7-first-message', overrides: null, templateIds: null });
  m.settleStartRow(st.box, st.id, 1, { kind: 'failed', reason: 'admission failed' });
  m.sendOutboxRow(st.box, st.id); // Send again → queued (the pump starts a new session with it)
  readd(PG);
  await release(st.box);
  const stG = rowNow(st.box, st.id);
  q.restore(); check('R7 a start row (first message) after delete + re-add → not started inside the re-added project; failed', gotText('R7-first-message') === 0 && stG?.state === 'failed' && /removed from Orchard/.test(stG?.reason ?? ''), { handedOver: gotText('R7-first-message'), state: stG?.state, reason: (stG?.reason ?? '').slice(0, 80) }); Object.assign(q, quiet());

  /* R7b — start row, same project → still starts */
  await boot({ route: 'new' });
  const PG2 = newProject('b284-r7b');
  const st2 = m.mintStartRow({ projectId: PG2.id, text: 'R7b-first-message', overrides: null, templateIds: null });
  m.settleStartRow(st2.box, st2.id, 1, { kind: 'failed', reason: 'admission failed' });
  m.sendOutboxRow(st2.box, st2.id);
  await release(st2.box);
  q.restore(); check('R7b a start row of the SAME project → started (anti-regression)', gotText('R7b-first-message') === 1, { handedOver: gotText('R7b-first-message') }); Object.assign(q, quiet());

  /* R8 — caller-named incarnation already gone */
  await boot();
  const PH = newProject('b284-r8');
  const oldInc = reg.incarnationOf(PH);
  const PH2 = readd(PH);
  const sH = sidOf();
  const rH = enqueue(sH, PH2, 'R8-text', { projectIncarnation: oldInc });
  await release(sH);
  const stH = rowNow(sH, rH.id);
  q.restore(); check('R8 a caller-named incarnation that is already gone (enqueued after the re-add) → not resumed', gotText('R8-text') === 0 && stH?.state === 'failed' && rH.resume.projectIncarnation === oldInc, { handedOver: gotText('R8-text'), state: stH?.state }); Object.assign(q, quiet());

  /* L1/L2 — legacy rows (no stamp): written by an outbox with no projectIdentity (as before BUG-284), then a restart */
  const legacyRow = async (p, text) => {
    try { m?.stopOutbox(); } catch { /* */ }
    ctl = makeCtl();
    m = await loadOutbox(OUTBOX); m.startOutbox(ctl.wiring); await settle();
    const sid = sidOf();
    const r = enqueue(sid, p, text);
    return { sid, r };
  };
  const PL = newProject('b284-l1');
  await new Promise((r) => setTimeout(r, 5));
  const L1 = await legacyRow(PL, 'L1-text');
  await boot();
  await release(L1.sid);
  const stL1 = rowNow(L1.sid, L1.r.id);
  q.restore(); check('L1 legacy row (no stamp), project row older than it → delivered', !L1.r.resume.projectIncarnation && gotText('L1-text') === 1 && stL1?.state === 'delivered', { stamp: L1.r.resume.projectIncarnation ?? null, handedOver: gotText('L1-text'), state: stL1?.state }); Object.assign(q, quiet());
  const PL2 = newProject('b284-l2');
  const L2 = await legacyRow(PL2, 'L2-text');
  await new Promise((r) => setTimeout(r, 5));
  readd(PL2);
  await boot();
  await release(L2.sid);
  const stL2 = rowNow(L2.sid, L2.r.id);
  q.restore(); check('L2 legacy row (no stamp), project re-added AFTER it → not resumed; failed', !L2.r.resume.projectIncarnation && gotText('L2-text') === 0 && stL2?.state === 'failed', { stamp: L2.r.resume.projectIncarnation ?? null, handedOver: gotText('L2-text'), state: stL2?.state }); Object.assign(q, quiet());

  /* U1 — unreadable registry: wait, never fail */
  await boot();
  const PU = newProject('b284-u1');
  const sU = sidOf();
  const rU = enqueue(sU, PU, 'U1-text');
  identityThrows = true;
  await release(sU);
  const midU = rowNow(sU, rU.id);
  const holdU = m.outboxView(sU).hold;
  identityThrows = false;
  m.nudgeOutbox(sU); await new Promise((r) => setTimeout(r, 2100)); m.nudgeOutbox(sU); await settle(6);
  const stU = rowNow(sU, rU.id);
  q.restore(); check('U1 registry unreadable → waits (still queued, nothing sent); readable again → delivered once', midU?.state === 'queued' && holdU?.kind === 'project-unknown' && gotText('U1-text') === 1 && stU?.state === 'delivered', { mid: midU?.state, hold: holdU?.kind ?? null, handedOver: gotText('U1-text'), after: stU?.state }); Object.assign(q, quiet());

  /* B1 — mixed batch */
  await boot();
  const PM = newProject('b284-b1');
  const oldM = reg.incarnationOf(PM);
  const PM2 = readd(PM);
  const sM = sidOf();
  const rM1 = enqueue(sM, PM2, 'B1-old-text', { projectIncarnation: oldM });
  const rM2 = enqueue(sM, PM2, 'B1-current-text');
  await release(sM);
  q.restore(); check('B1 mixed queue: the removed incarnation\'s row fails, the current one is delivered once', rowNow(sM, rM1.id)?.state === 'failed' && rowNow(sM, rM2.id)?.state === 'delivered' && gotText('B1-old-text') === 0 && gotText('B1-current-text') === 1, { old: rowNow(sM, rM1.id)?.state, cur: rowNow(sM, rM2.id)?.state, prompts: ctl.prompts.length }); Object.assign(q, quiet());
} catch (err) {
  q.restore();
  check('the suite ran to completion', false, `${err.stack ?? err}`.slice(0, 1200));
} finally {
  q.restore();
  try { m?.stopOutbox(); } catch { /* */ }
}
console.log(`\n${pass} passed, ${fail} failed${fails.length ? `\nFAILED: ${fails.join(' | ')}` : ''}`);
process.exit(fail ? 1 : 0);
