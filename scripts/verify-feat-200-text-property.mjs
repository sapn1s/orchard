#!/usr/bin/env node
/**
 * FEAT-200 r11 — STANDING PROPERTY ASSERTION over every user-facing text producer of a container access request.
 *
 *   node scripts/verify-feat-200-text-property.mjs [--tree <dir>]
 *
 * Why it exists: IV r9 (2af93888) and IV r10 (ee013774) both broke on WORDING only — the card, then a 409 body reached
 * only by a direct API call — while every behavioural property held. Under WA §N's stopping rule no further verify
 * round was commissioned; this file is the containment instead. It asserts two properties for EVERY producer, in EVERY
 * end state, so the next producer or state cannot drift unseen:
 *
 *   P1  no producer claims "applied", "saved", "container ready" or "open/check the session" for a request whose
 *       project was removed (deleted) or replaced (deleted and re-added under the same id);
 *   P2  no producer suggests an action (a "reject it" / "cancel" text, an Approve/Reject/Cancel button, a Needs-You rail
 *       entry, "open the session") that the matching route then refuses in that same state.
 *
 * Producers (DISCOVERED, not just listed — see section I):
 *   - public/app.js accessStatusText (extracted and evaluated as is) over the REAL accessCardView, for every outbox
 *     row state; the card's Approve/Reject and Cancel button conditions (the exact source lines are asserted present);
 *   - the Needs-You rail predicate in src/server/index.ts (extracted and evaluated as is);
 *   - every 4xx of the decide (= approve and reject) and cancel routes in src/server/index.ts: inventoried from the
 *     source; the record-state ones are driven through the functions the routes call (access-channel decideRefusal,
 *     access-requests beginDecision, access-channel cancelByUser); the others are classified (caller / body / project
 *     state, reachable only past the record-state checks) and their action advice is checked against the route;
 *   - every error literal of cancelByUser and every AccessStoreError of beginDecision (inventoried, then driven).
 * A producer that appears in those regions without an inventory entry FAILS ("not covered"); an inventoried producer
 * that disappears FAILS ("known producer gone") — so a new one is never silently missed.
 *
 * End states: undecided, undecided with a port conflict, approved-pending, granted (committed), denied, cancelled by a
 * user edit, could not be applied, could not be saved — each in the CURRENT project, after the project was REMOVED,
 * and after it was REPLACED; for the open states also after the commit pass closed them as removed.
 * Real store, real registry (createProject / deleteProject in a scratch data dir). Synthetic by necessity: there is no
 * real removed-project artifact to replay; the e2e suite (blocks D, Q, QR) drives the real HTTP path.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const argTree = process.argv.indexOf('--tree');
const ROOT = argTree > 0 ? path.resolve(process.argv[argTree + 1]) : path.resolve(HERE, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'feat200-prop-data-'));
process.env.CLAUDE_STATION_DATA = DATA;
fs.writeFileSync(path.join(DATA, 'registry.json'), JSON.stringify({ version: 1, projects: [] }, null, 2));

let pass = 0, fail = 0;
function check(name, ok, observed) {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  — observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`}`);
}
const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const mod = (rel) => import(url.pathToFileURL(path.join(ROOT, rel)).href);
const acc = await mod('src/server/access-requests.ts');
const ch = await mod('src/server/access-channel.ts');
const reg = await mod('src/server/registry.ts');

/** The body of the brace block that starts at the first `{` at/after `from` (inclusive). */
function block(text, from) {
  let depth = 0;
  for (let i = text.indexOf('{', from); i < text.length; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (!depth) return text.slice(from, i + 1); }
  }
  return null;
}
/** The statement starting at `at` up to its closing `)` of the outer call (paren matching). */
function call(text, at) {
  let depth = 0;
  for (let i = text.indexOf('(', at); i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (!depth) return text.slice(at, i + 1); }
  }
  return text.slice(at, at + 200);
}

/* ======================================================================= I — producer inventory (discovered) */
console.log('\n--- I: every user-facing text producer of an access request is inventoried (a new one fails loudly)');
const IDX = src('src/server/index.ts');
const APP = src('public/app.js');
const CHS = src('src/server/access-channel.ts');
const ACS = src('src/server/access-requests.ts');
const decideAt = IDX.indexOf("rest[2] === 'access-requests' && rest[3] && rest[4] === 'decide'");
const cancelAt = IDX.indexOf("rest[2] === 'access-requests' && rest[3] && rest[4] === 'cancel'");
const decideSrc = decideAt > 0 ? block(IDX, decideAt) : null;
const cancelSrc = cancelAt > 0 ? block(IDX, cancelAt) : null;
check('I0 the decide route and the cancel route are found in src/server/index.ts', !!decideSrc && !!cancelSrc, { decideAt, cancelAt });

/*
 * Every non-2xx response of the two routes. kind:
 *   driven     — record-state dependent; its text comes from a function driven below in every end state;
 *   caller     — depends only on who calls (agent → 403), not on the request's state;
 *   input      — depends only on the request body;
 *   project    — "no project <id>" (the route's own 404 when no row is under the id at all);
 *   unknownrec — "no access request <id> in project <id>";
 *   approvegate— reached ONLY on approve, ONLY after the record-state refusal passed (so the record is undecided and
 *                in its current project); `advises` names the action its text suggests, checked in section D.
 */
const ROUTE_PRODUCERS = [
  { route: 'decide', re: /^sendJson\(res, notUser\.status, notUser\.body\)/, kind: 'caller', n: 1 },
  { route: 'decide', re: /^notFound\(res, `no project \$\{id\}`\)/, kind: 'project', n: 2 },
  { route: 'decide', re: /^sendJson\(res, 400, \{ error: \(err as Error\)\.message \}\)/, kind: 'input', n: 1 },
  { route: 'decide', re: /^sendJson\(res, 400, \{ error: 'verdict must be/, kind: 'input', n: 1 },
  { route: 'decide', re: /^notFound\(res, `no access request \$\{rid\} in project \$\{id\}`\)/, kind: 'unknownrec', n: 1 },
  { route: 'decide', re: /^sendJson\(res, 409, \{ error: refusal\.error, code: refusal\.code/, kind: 'driven', n: 1, via: 'decideRefusal' },
  { route: 'decide', re: /code: 'not-container'/, kind: 'approvegate', n: 1, advises: null },
  { route: 'decide', re: /code: 'port-conflict'/, kind: 'approvegate', n: 1, advises: null },
  { route: 'decide', re: /code: 'changed-since-request'/, kind: 'approvegate', n: 1, advises: 'reject' },
  { route: 'decide', re: /^sendJson\(res, 400, \{ error: `cannot approve: \$\{\(err as Error\)\.message\}`/, kind: 'approvegate', n: 1, advises: null },
  { route: 'decide', re: /^sendJson\(res, err\.code === 'unknown' \? 404/, kind: 'driven', n: 1, via: 'beginDecision' },
  { route: 'cancel', re: /^sendJson\(res, notUser\.status, notUser\.body\)/, kind: 'caller', n: 1 },
  { route: 'cancel', re: /^notFound\(res, `no project \$\{id\}`\)/, kind: 'project', n: 1 },
  { route: 'cancel', re: /^sendJson\(res, r\.code === 'unknown' \? 404/, kind: 'driven', n: 1, via: 'cancelByUser' },
];
function inventory(routeName, body) {
  const found = [];
  const re = /sendJson\(res,|notFound\(res,/g;
  let m;
  while ((m = re.exec(body))) {
    const stmt = call(body, m.index).replace(/\s+/g, ' ');
    if (/^sendJson\(res, 200\b/.test(stmt)) continue; // success bodies are the card view (accessStatusText, driven)
    found.push(stmt);
  }
  const mine = ROUTE_PRODUCERS.filter((p) => p.route === routeName);
  const uncovered = found.filter((s) => !mine.some((p) => p.re.test(s)));
  const counts = mine.map((p) => ({ p, got: found.filter((s) => p.re.test(s)).length }));
  check(`I1 ${routeName} route: every non-2xx response is inventoried (no new producer slipped in uncovered)`, uncovered.length === 0, uncovered);
  const gone = counts.filter((c) => c.got !== c.p.n).map((c) => ({ producer: String(c.p.re), expected: c.p.n, got: c.got }));
  check(`I2 ${routeName} route: every inventoried producer is still there, exactly as often (a vanished or duplicated one fails)`, gone.length === 0, gone);
}
if (decideSrc) inventory('decide', decideSrc);
if (cancelSrc) inventory('cancel', cancelSrc);

// cancelByUser's own error texts, and beginDecision's AccessStoreErrors: inventoried, then driven in section D.
const cbuAt = CHS.indexOf('export function cancelByUser(');
const cbuSrc = cbuAt > 0 ? block(CHS, CHS.lastIndexOf('{', CHS.indexOf('\n', cbuAt))) : null;
const cbuErrors = cbuSrc ? (cbuSrc.match(/code: '[a-z-]+', error:/g) ?? []).map((s) => s.match(/'([a-z-]+)'/)[1]) : [];
const CBU_KNOWN = ['unreadable', 'unknown', 'unreadable', 'project-removed', 'not-pending', 'not-pending'];
check('I3 cancelByUser: its error producers are exactly the inventoried ones, in order (store unreadable, unknown id, registry unreadable, project removed, not pending, state changed)', JSON.stringify(cbuErrors) === JSON.stringify(CBU_KNOWN), cbuErrors);
const bdAt = ACS.indexOf('export function beginDecision(');
const bdSrc = bdAt > 0 ? block(ACS, bdAt) : null;
const bdErrors = bdSrc ? (bdSrc.match(/new AccessStoreError\('[a-z-]+'/g) ?? []).map((s) => s.match(/'([a-z-]+)'/)[1]) : [];
const BD_KNOWN = ['unreadable', 'unknown', 'already-decided', 'unreadable', 'project-removed', 'already-decided'];
check('I4 beginDecision: its AccessStoreErrors are exactly the inventoried ones, in order', JSON.stringify(bdErrors) === JSON.stringify(BD_KNOWN), bdErrors);
const drAt = CHS.indexOf('export function decideRefusal(');
check('I5 the decide route\'s record-state refusal is ONE function (access-channel decideRefusal), so it can be driven here', drAt > 0 && typeof ch.decideRefusal === 'function', { inSource: drAt > 0, exported: typeof ch.decideRefusal });

// The card (app.js): the status text, and the exact button conditions this file models.
const fnAt = APP.indexOf('function accessStatusText(rec) {');
const accessStatusText = fnAt > 0 ? new Function(`${block(APP, fnAt)}; return accessStatusText;`)() : null;
check('I6 public/app.js accessStatusText is found and evaluates', typeof accessStatusText === 'function', fnAt);
const BUTTONS_DECIDE = 'if (!rec.decision && !rec.notApplied && !rec.projectRemoved) {';
const BUTTONS_CANCEL = '} else if (rec.cancellable && !rec.projectRemoved) {';
const cardAt = APP.indexOf('function accessCardParts(');
const cardSrc = cardAt > 0 ? block(APP, cardAt) : '';
check('I7 the card\'s Approve/Reject and Cancel button conditions are the ones modelled here (change them → update this file)', cardSrc.includes(BUTTONS_DECIDE) && cardSrc.includes(BUTTONS_CANCEL), { decide: cardSrc.includes(BUTTONS_DECIDE), cancel: cardSrc.includes(BUTTONS_CANCEL) });
const showsDecide = (v) => !v.decision && !v.notApplied && !v.projectRemoved;
const showsCancel = (v) => !showsDecide(v) && !!v.cancellable && !v.projectRemoved;
const cardButtonTexts = (cardSrc.match(/text: '([A-Z][a-z]+(?: request)?)'/g) ?? []).map((s) => s.slice(7, -1));
check('I8 the card\'s buttons are exactly Reject, Approve, Cancel request (a new button fails until it is modelled)', JSON.stringify(cardButtonTexts) === JSON.stringify(['Reject', 'Approve', 'Cancel request']), cardButtonTexts);

// The Needs-You rail: its predicate, extracted from index.ts and evaluated as is.
const railAt = IDX.indexOf('access.listAccessForProject(p.id).filter(');
let railPred = null;
if (railAt > 0) {
  const s = call(IDX, railAt + 'access.listAccessForProject(p.id)'.length);
  const inner = s.slice(s.indexOf('(') + 1, -1);
  try { railPred = new Function('access', 'accMemo', `return (${inner});`)(acc, new Map()); } catch (e) { railPred = null; }
}
check('I9 the Needs-You rail predicate is found in index.ts and evaluates', typeof railPred === 'function', railAt);
const railTitle = /title: `Container access for \$\{r\.projectName\}: \$\{access\.summarise\(r\.changes\)\}`/.test(IDX) && /question: r\.reason,/.test(IDX);
check('I10 the rail item\'s own text is the request summary and the agent\'s reason (it claims no state; the card it embeds is accessStatusText)', railTitle, null);

/* ======================================================================= the routes, as the code composes them */
// Only for the must-FAIL run on a pre-r11 tree (no decideRefusal): index.ts's inline checks of that tree, transcribed.
const preR11Refusal = (rec) => rec.decision ? { code: 'already-decided', error: `access request ${rec.id} was already ${rec.decision.verdict}; a decision is honoured once` }
  : acc.classOf(rec).kind === 'removed' || rec.notApplied?.cause === 'removed' ? { code: 'project-removed', error: `access request ${rec.id} was raised for a project that has since been removed from Orchard; a project added later has the same id. It cannot be approved here; its session is told it is not in effect.` } : null;
// decide = index.ts order: no project row → 404; record-state refusal (decideRefusal); then beginDecision.
const decideRoute = (rec, verdict) => {
  if (!reg.getProject(rec.projectId)) return { ok: false, status: 404, error: `no project ${rec.projectId}` };
  const r = ch.decideRefusal ? ch.decideRefusal(rec) : preR11Refusal(rec);
  if (r) return { ok: false, status: 409, error: r.error, code: r.code };
  try { acc.beginDecision(rec.id, verdict); return { ok: true }; } catch (e) { return { ok: false, status: e.code === 'unknown' ? 404 : 409, error: e.message, code: e.code }; }
};
// cancel = index.ts order: no project row → 404; then cancelByUser.
const cancelRoute = (rec) => {
  if (!reg.getProject(rec.projectId)) return { ok: false, status: 404, error: `no project ${rec.projectId}` };
  const r = ch.cancelByUser(rec.id, rec.projectId);
  return r.ok ? { ok: true } : { ok: false, status: r.code === 'unknown' ? 404 : 409, error: r.error, code: r.code };
};

/* ======================================================================= fixtures: one fresh project per probe */
const STATES = ['undecided', 'undecidedConflict', 'pending', 'granted', 'denied', 'cancelled', 'refused', 'saveFailed'];
const WHERE = ['current', 'removed', 'replaced'];
const OPEN = new Set(['undecided', 'undecidedConflict', 'pending']);
let seq = 0;
function fixture(state, where, closedByPass) {
  const n = ++seq;
  const dir = fs.mkdtempSync(path.join(DATA, 'proj-'));
  const mk = () => reg.createProject({ name: `prop${n}`, hostPath: dir, isolation: 'container', settings: { tools: { playwright: false, serena: false, openaiDispatch: false }, laneDocker: 'sandbox', container: { gpu: 'off', env: {}, ports: [] } } });
  const P = mk();
  const rec = acc.raiseAccess({ projectId: P.id, projectName: P.name, projectIncarnation: reg.incarnationOf(reg.getProject(P.id)), sdkSessionId: `sess-${n}`, reason: 'needs the host db', changes: [{ kind: 'env', key: `K${n}`, value: 'v', previous: null }], conflicts: state === 'undecidedConflict' ? ['host port 41001 is used by project other'] : [] });
  const id = rec.id;
  const row = (rowId) => acc.noteResume(id, { state: 'queued', rowId });
  if (state === 'pending') acc.beginDecision(id, 'approved');
  if (state === 'granted') { acc.beginDecision(id, 'approved'); const cur = reg.getProject(P.id).accessCommitted ?? []; reg.updateProject(P.id, {}, { accessCommit: true, committed: [...cur, id] }); acc.markCommitted({ [id]: '[station] access granted' }); row(`row-${n}`); }
  if (state === 'denied') { acc.beginDecision(id, 'rejected'); acc.noteResume(id, { state: 'frozen', text: 'denied' }); row(`row-${n}`); }
  if (state === 'cancelled') { acc.beginDecision(id, 'approved'); acc.markNotApplied([{ id, reason: 'the user changed K in the project settings', text: 'cancelled' }], 'cancelled'); row(`row-${n}`); }
  if (state === 'refused') { acc.beginDecision(id, 'approved'); acc.markNotApplied([{ id, reason: 'Bind for 127.0.0.1:41001 failed: port is already allocated', text: 'could not be applied' }], 'refused'); row(`row-${n}`); }
  if (state === 'saveFailed') { acc.beginDecision(id, 'approved'); acc.markNotApplied([{ id, reason: 'EACCES writing the registry', text: 'could not be saved' }], 'save-failed'); row(`row-${n}`); }
  if (where !== 'current') { reg.deleteProject(P.id); if (where === 'replaced') { const P2 = mk(); if (P2.id !== P.id) throw new Error(`re-add got ${P2.id}, not ${P.id}`); } }
  // The commit pass closes an open request of a gone incarnation as removed (access-channel, cause 'removed').
  if (closedByPass) acc.markNotApplied([{ id, reason: 'its project was removed from Orchard', text: ch.projectRemovedTextFor(acc.getAccess(id)) }], 'removed');
  return acc.getAccess(id);
}
const CASES = [];
for (const s of STATES) for (const w of WHERE) {
  CASES.push({ s, w, closed: false });
  if (w !== 'current' && OPEN.has(s)) CASES.push({ s, w, closed: true });
}
const label = (c) => `${c.s}/${c.w}${c.closed ? '+closed-by-pass' : ''}`;

/* ======================================================================= D — drive every producer in every state */
console.log(`\n--- D: ${CASES.length} end states × every producer`);
const CLAIM = [
  /open the session|check the session/i,
  /container ready/i,
  /(?<!\b(?:not|never|could not be|cannot be)\s)\b(?:applied|saved)\b/i,
];
const claims = (t) => CLAIM.filter((re) => re.test(t)).map(String);
const DELIVERIES = [null, 'queued', 'delivered', 'failed', 'uncertain', 'discarded', 'unknown'];
const p1 = [], p2 = [], seen = { texts: 0, decide: 0, cancel: 0 };
const accepted = {};
for (const c of CASES) {
  // Acceptance of each action in THIS state, each on its own fresh fixture (the routes mutate).
  const acceptReject = decideRoute(fixture(c.s, c.w, c.closed), 'rejected');
  const acceptApprove = decideRoute(fixture(c.s, c.w, c.closed), 'approved');
  const acceptCancel = cancelRoute(fixture(c.s, c.w, c.closed));
  accepted[label(c)] = { reject: acceptReject.ok, approve: acceptApprove.ok, cancel: acceptCancel.ok };
  const gone = c.w !== 'current';
  const rec = fixture(c.s, c.w, c.closed);
  const cls = acc.classOf(rec);
  const texts = [];
  for (const d of DELIVERIES) {
    const v = acc.accessCardView(rec, cls, d, () => null);
    texts.push({ who: `accessStatusText(delivery=${d})`, t: accessStatusText(v) });
    // P2 — the card's affordances against the routes.
    if (showsDecide(v) && !(acceptReject.ok && acceptApprove.ok)) p2.push({ state: label(c), who: 'card shows Approve/Reject', reject: acceptReject, approve: acceptApprove });
    if (showsCancel(v) && !acceptCancel.ok) p2.push({ state: label(c), who: 'card shows Cancel request', cancel: acceptCancel });
  }
  // P2 — the rail lists only what the decide route then accepts.
  if (railPred && railPred(rec) && !(acceptReject.ok && acceptApprove.ok)) p2.push({ state: label(c), who: 'Needs-You rail lists it', reject: acceptReject, approve: acceptApprove });
  for (const r of [acceptReject, acceptApprove]) if (!r.ok) { texts.push({ who: `decide ${r.status}`, t: r.error }); seen.decide++; }
  if (!acceptCancel.ok) { texts.push({ who: `cancel ${acceptCancel.status}`, t: acceptCancel.error }); seen.cancel++; }
  // cancelByUser called directly too (the route's 404 for a missing row hides it in 'removed'; a stale tab can reach it
  // the moment a project is re-added).
  const fd = fixture(c.s, c.w, c.closed);
  const direct = ch.cancelByUser(fd.id, fd.projectId);
  if (!direct.ok) texts.push({ who: 'cancelByUser', t: direct.error });
  // The approve-only gates (reached only when the record-state refusal passed): their advice must hold in that state.
  const passesRefusal = !!reg.getProject(rec.projectId) && !(ch.decideRefusal ? ch.decideRefusal(rec) : preR11Refusal(rec));
  for (const g of ROUTE_PRODUCERS.filter((p) => p.kind === 'approvegate' && p.advises)) {
    if (passesRefusal && g.advises === 'reject' && !acceptReject.ok) p2.push({ state: label(c), who: `approve gate ${g.re} advises "reject it"`, reject: acceptReject });
  }
  for (const { who, t } of texts) {
    seen.texts++;
    if (gone) { const k = claims(t); if (k.length) p1.push({ state: label(c), who, text: t, claims: k }); }
    if (/reject it/i.test(t) && !acceptReject.ok) p2.push({ state: label(c), who, text: t, but: acceptReject.error });
    if (/\bapprove it\b/i.test(t) && !acceptApprove.ok) p2.push({ state: label(c), who, text: t, but: acceptApprove.error });
    if (/\bcancel it\b|cancel (?:the|this) request/i.test(t) && !acceptCancel.ok) p2.push({ state: label(c), who, text: t, but: acceptCancel.error });
    if (/open the session|check the session/i.test(t) && gone) p2.push({ state: label(c), who, text: t, but: 'the session belongs to a removed project' });
  }
}
console.log(`  (${seen.texts} texts graded; ${seen.decide} decide refusals, ${seen.cancel} cancel refusals)`);
check(`P1 no producer claims "applied" / "saved" / "container ready" / "open the session" for a removed or replaced project (${CASES.filter((c) => c.w !== 'current').length} gone states)`, p1.length === 0, p1);
check(`P2 no producer suggests an action (text, button, rail entry) that the matching route then refuses (${CASES.length} states)`, p2.length === 0, p2);

/* ======================================================================= A — anti-regressions: the current project keeps its truths */
console.log('\n--- A: anti-regressions (current project)');
const A = (s) => accepted[`${s}/current`];
check('A1 undecided (current): Approve, Reject accepted; Cancel refused', A('undecided').approve && A('undecided').reject && !A('undecided').cancel, A('undecided'));
check('A2 approved-pending (current): Cancel accepted; a second decision refused', A('pending').cancel && !A('pending').approve && !A('pending').reject, A('pending'));
for (const s of ['granted', 'denied', 'cancelled', 'refused', 'saveFailed']) check(`A3 ${s} (current): nothing can be decided or cancelled again`, !A(s).approve && !A(s).reject && !A(s).cancel, A(s));
const gf = fixture('granted', 'current', false);
const gr = ch.cancelByUser(gf.id, gf.projectId);
check('A4 granted (current): the cancel refusal still says it is applied and saved (true in its own project)', !gr.ok && /already applied to the container and saved/.test(gr.error), gr);
const un = fixture('undecided', 'current', false);
const unc = ch.cancelByUser(un.id, un.projectId);
check('A5 undecided (current): the cancel refusal still advises "reject it instead" — and reject is accepted (P2 above)', !unc.ok && /reject it instead/.test(unc.error), unc);
const gv = acc.accessCardView(fixture('granted', 'current', false), { kind: 'final', where: 'current' }, 'failed', () => null);
check('A6 granted (current), row failed: the card still says "open the session" (the session IS this project\'s)', /open the session to see it/.test(accessStatusText(gv)), accessStatusText(gv));
for (const c of CASES.filter((x) => x.w !== 'current')) { const a = accepted[label(c)]; if (a.approve || a.reject || a.cancel) check(`A7 ${label(c)}: no action is accepted on a gone project's request`, false, a); }
check('A7 no action (approve, reject, cancel) is accepted on any removed or replaced project\'s request', CASES.filter((x) => x.w !== 'current').every((c) => { const a = accepted[label(c)]; return !a.approve && !a.reject && !a.cancel; }), null);

console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* */ }
process.exit(fail ? 1 : 0);
