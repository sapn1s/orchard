#!/usr/bin/env node
/**
 * verify-bug-255-r4-structure.mjs — BUG-255 r4: the account a launch uses is decided in ONE
 * place, launch-account.ts `effectiveLaunchAccount`. Structural + behavioural checks that fail
 * if any spawn can receive an account from anywhere else:
 *   S1 inventory: every session-construction call site in src/ (startSession / new AgentSession /
 *      adoptSession) is a KNOWN site; a new one fails until it is reviewed and listed here.
 *   S2 no call site hands a spawn its own account (no `claudeAccount` in its arguments).
 *   S3 the AgentSession constructor assigns `effective.claudeAccount` exactly once, from
 *      effectiveLaunchAccount, and its per-launch override loop skips claudeAccount.
 *   S4 runtime tripwire: startSession REFUSES overrides.claudeAccount (before anything runs),
 *      and refuses an initialBinding on a resume.
 *   S5 the other deciders call the same function: the container credential bind
 *      (containerAccountId) and the indicator's declared `next` (nextResumeAccountOf); the
 *      CLAUDE_CONFIG_DIR is resolved from `effective` only; dropBoundAccountOverride is gone.
 *   S6 the decision table of effectiveLaunchAccount (container / bound / unbound / new pick /
 *      machine default), on the real module.
 *   MUST-FAIL: S1-S3 + S5 graded against the synthesized pre-fix tree (BUG255_PRE_ROOT,
 *   default /tmp/bug255r4-preroot) must FAIL; skipped (and said) if that tree is absent.
 * Isolation: a scratch CLAUDE_STATION_DATA / HOME; nothing is spawned.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRE_ROOT = process.env.BUG255_PRE_ROOT ?? '/tmp/bug255r4-preroot';
let pass = 0, fail = 0;
const ok = (c, name, observed) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`); c ? pass++ : fail++; return c; };
const section = (t) => console.log(`\n== ${t}`);

/** Every .ts under src (not tests). */
function tsFiles(root) {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && !e.name.endsWith('.d.ts')) out.push(p); } };
  walk(path.join(root, 'src'));
  return out;
}
/** The balanced-paren argument text of a call starting at `i` (index of the opening paren). */
function argsAt(src, i) {
  let depth = 0;
  for (let j = i; j < src.length; j++) { const ch = src[j]; if (ch === '(') depth++; else if (ch === ')') { depth--; if (depth === 0) return src.slice(i + 1, j); } }
  return src.slice(i + 1);
}
const KNOWN_SITES = {
  // file → [the enclosing marker each call site sits under] — reviewed: none decides an account.
  'src/server/index.ts': ['runNewSessionStart', 'handOver-resume', 'ws-start', 'adopt-boot'],
  'src/server/agent-bridge.ts': ['startSessionAdmitting', 'adoptSession'],
};
function siteLabel(file, src, idx) {
  const before = src.slice(Math.max(0, idx - 12000), idx);
  if (file.endsWith('index.ts')) {
    if (/function runNewSessionStart\(/.test(before.slice(-4000))) return 'runNewSessionStart';
    if (/Resume from the transcript, with no socket/.test(before.slice(-3000))) return 'handOver-resume';
    if (/runNewSessionStart\(\{[\s\S]*\.session\s*:\s*startSession\($/.test(before.slice(-1500) + 'startSession(') || /\.session\s*\n\s*:\s*$/.test(before.slice(-200))) return 'ws-start';
    if (/adoptSession\($/.test(src.slice(idx, idx + 13))) return 'adopt-boot';
    return 'UNKNOWN';
  }
  if (/new AgentSession\(id, \{ \.\.\.opts/.test(src.slice(idx, idx + 40))) return 'startSessionAdmitting';
  if (/new AgentSession\(id, \{ project, firstPrompt: ''/.test(src.slice(idx, idx + 60))) return 'adoptSession';
  return 'UNKNOWN';
}

function structural(ROOT, tag) {
  const results = {};
  const rd = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  section(`[${tag}] S1/S2 every session-construction call site is known and passes no account of its own`);
  const sites = [];
  for (const f of tsFiles(ROOT)) {
    const src = fs.readFileSync(f, 'utf8'); const rel = path.relative(ROOT, f);
    for (const m of src.matchAll(/(?<![\w.])(startSession|adoptSession)\(|new AgentSession\(/g)) {
      const before = src.slice(Math.max(0, m.index - 30), m.index);
      if (/(function|async function)\s*$/.test(before)) continue; // the declaration itself
      const lineStart = src.lastIndexOf('\n', m.index) + 1; const line = src.slice(lineStart, src.indexOf('\n', m.index));
      if (/^\s*(\*|\/\/|\/\*)/.test(line) || /\/\/.*$/.test(line.slice(0, m.index - lineStart)) ) continue; // a comment
      if (/`[^`]*$/.test(line.slice(0, m.index - lineStart)) || /'[^']*$/.test(line.slice(0, m.index - lineStart))) continue; // inside a string
      const paren = m.index + m[0].length - 1;
      const args = argsAt(src, paren);
      sites.push({ rel, line: src.slice(0, m.index).split('\n').length, label: siteLabel(rel, src, m.index), args });
    }
  }
  const unknown = sites.filter((s) => !(KNOWN_SITES[s.rel] ?? []).includes(s.label));
  ok(sites.length >= 6 && unknown.length === 0, `[${tag}] S1 the ${sites.length} construction sites are all known (no unreviewed spawn path)`, sites.map((s) => `${s.rel}:${s.line} ${s.label}`));
  const withAccount = sites.filter((s) => /claudeAccount/.test(s.args));
  ok(withAccount.length === 0, `[${tag}] S2 no call site passes a claudeAccount of its own`, withAccount.map((s) => `${s.rel}:${s.line}`));
  results.S1 = unknown.length === 0; results.S2 = withAccount.length === 0;

  section(`[${tag}] S3 the constructor: one assignment, from effectiveLaunchAccount; the override loop skips the account`);
  const bridge = rd('src/server/agent-bridge.ts');
  const assigns = [...bridge.matchAll(/effective\.claudeAccount\s*=(?!=)/g)].map((m) => bridge.slice(m.index, bridge.indexOf('\n', m.index)).trim());
  const s3a = assigns.length === 1 && /effective\.claudeAccount = effectiveLaunchAccount\(/.test(assigns[0] ?? '');
  ok(s3a, `[${tag}] S3a effective.claudeAccount is assigned exactly once, from effectiveLaunchAccount`, assigns);
  const loop = bridge.slice(bridge.indexOf('for (const field of SESSION_OVERRIDE_FIELDS)'), bridge.indexOf('for (const field of SESSION_OVERRIDE_FIELDS)') + 400);
  const s3b = /if \(field === 'claudeAccount'\) continue;/.test(loop);
  ok(s3b, `[${tag}] S3b the per-launch override loop skips claudeAccount (an override can never set the account)`, s3b);
  const dirFrom = /resolveLaunchAccountDir\(\(s as Overridable\)\.claudeAccount\)/.test(bridge) && /const s = effective;/.test(bridge);
  ok(dirFrom, `[${tag}] S3c CLAUDE_CONFIG_DIR is resolved from \`effective\` (the function's answer) only`, dirFrom);
  results.S3 = s3a && s3b && dirFrom;

  section(`[${tag}] S5 the container bind and the declared fact call the same function; the old guard is gone`);
  const cm = rd('src/server/container-manager.ts');
  const cai = cm.slice(cm.indexOf('export function containerAccountId('), cm.indexOf('export function containerAccountId(') + 400);
  const s5a = /effectiveLaunchAccount\(/.test(cai);
  ok(s5a, `[${tag}] S5a containerAccountId (the credential bind) delegates to effectiveLaunchAccount`, cai.split('\n').slice(0, 5).join(' | '));
  const idx = rd('src/server/index.ts');
  const nra = idx.slice(idx.indexOf('function nextResumeAccountOf('), idx.indexOf('function nextResumeAccountOf(') + 400);
  const s5b = /effectiveLaunchAccount\(\{ sessionId: sid \}, proj\)/.test(nra);
  ok(s5b, `[${tag}] S5b the indicator's declared next (nextResumeAccountOf) is effectiveLaunchAccount — the same decision as the spawn`, nra.split('\n').slice(0, 4).join(' | '));
  const sa = rd('src/server/session-accounts.ts');
  const s5c = !/export function dropBoundAccountOverride/.test(sa) && !/dropBoundAccountOverride\(/.test(idx);
  ok(s5c, `[${tag}] S5c dropBoundAccountOverride (the bound-only strip that left unbound overrides honoured) is deleted`, s5c);
  results.S5 = s5a && s5b && s5c;
  return results;
}

/* ---------------------------------------------------------------- main */
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'bug255r4s-'));
process.on('exit', () => { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch {} });
const DATA = path.join(SCRATCH, 'data'); const HOME = path.join(SCRATCH, 'home');
for (const d of [DATA, path.join(HOME, '.claude', 'projects')]) fs.mkdirSync(d, { recursive: true });
process.env.CLAUDE_STATION_DATA = DATA; process.env.HOME = HOME; process.env.CLAUDE_PROJECTS_DIR = path.join(SCRATCH, 'store');
delete process.env.CLAUDE_CONFIG_DIR;

const fixed = structural(REPO, 'fixed');

section('[fixed] S4 runtime tripwire — startSession refuses a caller-chosen account before anything runs');
const bridgeMod = await import(path.join(REPO, 'src', 'server', 'agent-bridge.ts'));
const fakeProject = { id: 'p-struct', name: 'p', hostPath: path.join(SCRATCH, 'work'), isolation: 'direct', settings: {} };
const events = [];
let err1 = null; try { await bridgeMod.startSession({ project: fakeProject, firstPrompt: 'x', overrides: { claudeAccount: 'aaaaaaaaaaaaaaaaaaaaaaaa' }, onEvent: (e) => events.push(e) }); } catch (e) { err1 = e; }
ok(!!err1 && /BUG-255: overrides\.claudeAccount must not reach a spawn/.test(err1.message) && events.length === 0,
  '[fixed] S4a startSession({overrides:{claudeAccount}}) throws the BUG-255 tripwire, before any event/spawn', { error: err1?.message?.slice(0, 120), events: events.length });
let err2 = null; try { await bridgeMod.startSession({ project: fakeProject, firstPrompt: 'x', resumeSessionId: '11111111-2222-3333-4444-555555555555', initialBinding: { account: null }, onEvent: () => {} }); } catch (e) { err2 = e; }
ok(!!err2 && /initialBinding is only for a NEW session/.test(err2.message), '[fixed] S4b an initialBinding on a RESUME is refused (an existing session\'s account is its binding or its project\'s)', err2?.message?.slice(0, 120));

section('[fixed] S6 the decision table (real launch-account.ts, real session-accounts store)');
const la = await import(path.join(REPO, 'src', 'server', 'launch-account.ts'));
const sa = await import(path.join(REPO, 'src', 'server', 'session-accounts.ts'));
const BOUND = '22222222-3333-4444-5555-666666666666', UNB = '33333333-4444-5555-6666-777777777777';
const A = 'aaaaaaaaaaaaaaaaaaaaaaaa', B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
sa.setSessionAccount(BOUND, A);
const direct = { isolation: 'direct', settings: { claudeAccount: B } };
const container = { isolation: 'container', settings: { claudeAccount: B } };
const table = [
  ['direct, bound A, project B → A (the binding)', la.effectiveLaunchAccount({ sessionId: BOUND }, direct), A],
  ['direct, unbound, project B → B (the project account)', la.effectiveLaunchAccount({ sessionId: UNB }, direct), B],
  ['CONTAINER, bound A, project B → B (the bind is project-scope; the binding is dormant)', la.effectiveLaunchAccount({ sessionId: BOUND }, container), B],
  ['new session, pick A, project B → A (its initial binding)', la.effectiveLaunchAccount({ sessionId: null, initialBinding: { account: A } }, direct), A],
  ['new session, pick A, CONTAINER project B → B', la.effectiveLaunchAccount({ sessionId: null, initialBinding: { account: A } }, container), B],
  ['an initialBinding never applies to an existing id (bound A, pick B) → A', la.effectiveLaunchAccount({ sessionId: BOUND, initialBinding: { account: B } }, direct), A],
  ['new session, explicit default pick (null) → null', la.effectiveLaunchAccount({ sessionId: null, initialBinding: { account: null } }, direct), null],
];
for (const [name, got, want] of table) ok(got === want, `S6 ${name}`, { got, want });
const tp = la.takeAccountPick({ claudeAccount: A, model: 'haiku' }, { newSession: false });
ok(tp.pick === undefined && tp.rest && !('claudeAccount' in tp.rest) && tp.rest.model === 'haiku', 'S6 takeAccountPick on an EXISTING session discards the pick unread, keeps the rest', tp);
const tn = la.takeAccountPick({ claudeAccount: A }, { newSession: true });
ok(tn.pick?.value === A && tn.rest === undefined, 'S6 takeAccountPick on a NEW session returns the pick separately (→ initialBinding)', tn);

if (fs.existsSync(path.join(PRE_ROOT, 'src', 'server', 'index.ts'))) {
  const before = { pass, fail };
  const pre = structural(PRE_ROOT, 'prefix');
  pass = before.pass; fail = before.fail; // the pre-fix FAIL lines above are evidence, not suite failures
  section('must-FAIL grading (the synthesized pre-fix tree must fail the structural checks)');
  ok(pre.S3 === false, 'must-FAIL: the pre-fix constructor decides the account in more than one place (override loop + binding block)', pre);
  ok(pre.S5 === false, 'must-FAIL: the pre-fix container bind / declared fact / bound-only guard are separate deciders', pre);
} else {
  console.log(`\n(must-FAIL half SKIPPED: no pre-fix tree at ${PRE_ROOT})`);
}
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
