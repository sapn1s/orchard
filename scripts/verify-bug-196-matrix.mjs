/**
 * BUG-196 round 6 — the provider/model lock, proven as a MATRIX, not case by case.
 *
 * Rounds 1-5 each proved the cases their fixer imagined, and each independent
 * verifier then found the neighbouring cell. This suite enumerates the whole space
 * and asserts ONE invariant per cell:
 *
 *   engine            {openai, anthropic}             — the engine the transcript pins
 *   pick              {none, valid-for-engine, valid-only-for-other, alias, garbage}
 *   project default   {same engine, other engine, equal-to-pick}
 *   read              {ok, failed}                    — the client's transcript read
 *   client provider   {absent, matching, contradicting, garbage}
 *
 * 2 × 5 × 3 × 2 × 4 = 240 cells. Every cell runs through the REAL product:
 *
 *   CLIENT leg (per cell, 240) — real headless Brave on a real server (free port,
 *     isolated stores). The cell's pick + client provider are PERSISTED the way the
 *     real app persists them (cs-overrides), the session is opened with the
 *     transcript read succeeding or failing (HTTP 500), the lock surfaces are READ
 *     FROM THE DOM (#provBtn, its popover, the Settings drawer's session-scope
 *     Provider control, the model popover's rows), then a REAL submit() resumes it.
 *     The start frame the page actually sent, the server's answer to it and the
 *     client's storage afterwards are graded.
 *   WIRE leg (per distinct frame, 120 = engine × pick × project × client provider;
 *     read is a client-side fact the server never sees) — a raw ws `start` carrying
 *     the client provider ON THE WIRE (the real client strips it, a stale or foreign
 *     client need not), plus named garbage provider values (null, "OpenAI", 42, {},
 *     ""). Graded on the server's own frames: no fatal, engine = the pin, model =
 *     the rule below, every pick the engine cannot run announced.
 *   UNIT leg — the ONE model→engine classifier (global-settings.modelProviderOf)
 *     over every id the matrix uses plus every Claude alias, with no catalog AND
 *     with a copy of the user's REAL catalog files.
 *
 * THE INVARIANT (per cell):
 *   - the resume runs on the PINNED engine; no client value is ever fatal;
 *   - model: a pick the engine can run is kept; a pick that belongs to the other
 *     engine (incl. a Claude alias on Codex) falls back to the engine default AND
 *     is announced (status + ignoredOverrides) — whatever the project default is,
 *     including equal to the pick; an unclassifiable pick is passed through AND
 *     announced; no pick → the project model only if it belongs to this engine;
 *   - a contradicting/garbage client provider is announced and ignored;
 *   - the client never sends a provider on a resume and never judges the model;
 *     it forgets a pick only when the server declares it ignored;
 *   - lock surfaces (button, popover, drawer) all paint ONE state: read ok → the
 *     pinned engine, locked, explained; read failed → engine UNKNOWN (nothing
 *     pressed, button says "not known yet"), locked, explained — never a guess;
 *     the model popover never offers the other engine's (or, unknown, any) catalog.
 *
 * MUST-FAIL: `BUG196_TREE=<frozen pre-fix tree> node scripts/verify-bug-196-matrix.mjs`
 * runs the SAME matrix against a frozen round-5 copy (it must go red on the five
 * round-5 breaks), and the synthesized graders below are fed the constructed
 * round-5 observations for all five breaks and must fail them.
 *
 * Sharding (each shard fits a 10-min foreground window):
 *   --leg=unit|wire|client|order|fresh   --engine=openai|anthropic   --read=ok|failed
 * No flags = everything.
 * BUG-196 round 7: --pick= --project= --cprov= --repeat=N narrow/repeat the client
 * cells; ORDER leg = forced orderings (pin lands after the surfaces painted; read
 * aborted by the browser); --inject-netfail / --no-env-retry reproduce and expose
 * the clean-room ERR_NETWORK_CHANGED signature (see openCell).
 *
 * Synthetic fixtures (stated per the conventions): transcripts are written in the
 * real on-disk shapes with synthetic content; the openai engine is the scripted
 * fake app-server; the Claude engine is a stub that records its argv and exits
 * (no quota, no API). The UNIT leg's second pass uses a COPY of the user's real
 * catalog files (read-only; the copy lives in scratch).
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';

const REPO = path.resolve(import.meta.dirname, '..');
const ROOT = path.resolve(process.env.BUG196_TREE ?? REPO); // the tree under test (a frozen copy for the must-FAIL run)
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const LEGS = args.leg ? args.leg.split(',') : ['unit', 'wire', 'client', 'order', 'fresh'];
const ENGINES = args.engine ? args.engine.split(',') : ['openai', 'anthropic'];
const READS = args.read ? args.read.split(',') : ['ok', 'failed'];
const VERBOSE = !!args.verbose;

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug196m-data-'));
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug196m-store-'));
const CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug196m-codexhome-'));
const CLAUDE_CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug196m-claudecfg-'));
const PROJ_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug196m-proj-'));
const RESUME_EXPECT = path.join(DATA, 'codex-expect-resume');
const CODEX_INPUT = path.join(DATA, 'codex-input.log');
const FAKE_CODEX = path.join(DATA, 'codex-fake-wrapper.mjs');
fs.writeFileSync(FAKE_CODEX,
  `import * as fs from 'node:fs';\n` +
  `try { process.env.CODEX_FAKE_EXPECT_RESUME = fs.readFileSync(${JSON.stringify(RESUME_EXPECT)}, 'utf8').trim(); } catch { /* none */ }\n` +
  `process.env.CODEX_FAKE_INPUT_LOG = ${JSON.stringify(CODEX_INPUT)};\n` +
  `await import(${JSON.stringify('file://' + path.join(ROOT, 'scripts', 'fixtures', 'codex-fake-app-server.mjs'))});\n`);
// The Claude engine: records its argv (so the model that REACHED it is provable),
// then exits. No network, no quota.
const CLAUDE_ARGV = path.join(DATA, 'claude-argv.log');
fs.mkdirSync(path.join(DATA, 'claude-bin'), { recursive: true });
const CLAUDE_STUB = path.join(DATA, 'claude-bin', 'claude'); // extensionless + CommonJS, the shape verify-bug-118's fake uses
fs.writeFileSync(CLAUDE_STUB,
  `#!/usr/bin/env node\nconst fs = require('node:fs');\n` +
  `try { fs.appendFileSync(${JSON.stringify(CLAUDE_ARGV)}, JSON.stringify(process.argv.slice(2)) + '\\n'); } catch (e) { process.stderr.write('STUBERR ' + e.message); }\nprocess.exit(1);\n`);
fs.chmodSync(CLAUDE_STUB, 0o755);
const encodeCwd = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  if (!ok || VERBOSE) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`}`);
  ok ? pass++ : (fail++, failures.push(name));
}

// ---------------------------------------------------------------------------
// The matrix vocabulary. The TEST's own expectation table — not the product's
// classifier — decides which engine each id belongs to.
// ---------------------------------------------------------------------------
const OTHER = { openai: 'anthropic', anthropic: 'openai' };
const NAME = { openai: 'OpenAI Codex', anthropic: 'Claude' };
const VALID = { openai: 'gpt-5-codex', anthropic: 'claude-opus-4-1' };       // a pick the engine runs
const VALID2 = { openai: 'gpt-6-sol', anthropic: 'claude-sonnet-4-5' };      // a DIFFERENT project model per engine
const ALIAS = { openai: 'opus', anthropic: 'haiku' };                          // Claude CLI aliases (the UI's static rows)
const GARBAGE = 'zz-not-a-model';                                              // no engine, no catalog, no prefix
const ENGINE_OF = (m) => (m == null ? null
  : /^claude/i.test(m) || /^(default|fable|opus|sonnet|haiku|opusplan)(\[.*\])?$/i.test(m) ? 'anthropic'
  : /^(gpt|o\d|codex)/i.test(m) ? 'openai' : null);
const PICKS = ['none', 'valid', 'other', 'alias', 'garbage'];
const PROJS = ['same', 'other', 'equal'];
const CPROVS = ['absent', 'matching', 'contradicting', 'garbage'];
const pickValue = (E, k) => ({ none: null, valid: VALID[E], other: VALID[OTHER[E]], alias: ALIAS[E], garbage: GARBAGE })[k];
const projSettings = (E, k, pick) => (k === 'same' ? { provider: E, model: VALID2[E] }
  : k === 'other' ? { provider: OTHER[E], model: VALID2[OTHER[E]] }
  : { provider: ENGINE_OF(pick) ?? OTHER[E], model: pick });
const cprovValue = (E, k) => ({ absent: undefined, matching: E, contradicting: OTHER[E], garbage: 'gemini' })[k];

/** What the invariant REQUIRES of the server for one frame. */
function expectFor(E, pick, proj, cp) {
  // No pick → the project's model only if it belongs to this engine (or cannot be
  // placed); else the engine default (null — no machine default in the scratch dir).
  const pe0 = ENGINE_OF(proj.model);
  const noPick = proj.model == null ? null : pe0 === E || pe0 == null ? proj.model : null;
  let model, pickVerdict = 'none';
  if (pick == null) model = noPick;
  else {
    const pe = ENGINE_OF(pick);
    if (pe === E) { model = pick; pickVerdict = 'kept'; }
    else if (pe == null) { model = pick; pickVerdict = 'unrecognised'; }
    else { model = noPick; pickVerdict = 'ignored'; } // an ignored pick is treated exactly as no pick
  }
  const providerAnnounced = cp !== undefined && cp !== E;
  return { engine: E, model, pickVerdict, providerAnnounced };
}

/** THE server grader: fed the frames the server sent for one start. */
function gradeServer(events, exp, pick) {
  const cfg = events.find((e) => e.t === 'effective-config');
  const fatal = events.find((e) => e.t === 'error' && (e.fatal || /overrides rejected/i.test(e.message ?? ''))
    && !(cfg && exp.engine === 'anthropic')); // after effective-config, the Claude STUB exiting is expected
  const statuses = events.filter((e) => e.t === 'status').map((e) => String(e.status));
  const ignoredStatus = pick != null && statuses.some((s) => s.includes(`ignored your model pick (${pick})`));
  const unrecStatus = pick != null && statuses.some((s) => s.includes(`model pick (${pick}) is not a recognised`));
  const ignoredDecl = !!cfg?.ignoredOverrides?.some((i) => i.field === 'model' && i.value === pick);
  const provStatus = statuses.some((s) => /ignored a stale provider choice/.test(s));
  const why = [];
  if (fatal) why.push(`fatal: ${String(fatal.message).slice(0, 120)}`);
  if (!cfg) why.push('no effective-config');
  if (cfg && cfg.provider !== exp.engine) why.push(`engine ${cfg.provider} ≠ ${exp.engine}`);
  if (cfg && (cfg.effective?.model ?? null) !== exp.model) why.push(`model ${JSON.stringify(cfg.effective?.model ?? null)} ≠ ${JSON.stringify(exp.model)}`);
  if (exp.pickVerdict === 'ignored' && !(ignoredStatus && ignoredDecl)) why.push(`invalid pick not announced (status=${ignoredStatus} decl=${ignoredDecl})`);
  if (exp.pickVerdict === 'ignored' && cfg?.overridden?.includes('model')) why.push('ignored pick still listed as overridden');
  if (exp.pickVerdict === 'unrecognised' && !unrecStatus) why.push('unrecognised pick passed through silently');
  if ((exp.pickVerdict === 'kept' || exp.pickVerdict === 'none') && (ignoredStatus || ignoredDecl)) why.push('a runnable pick was reported ignored');
  if (exp.providerAnnounced && !provStatus) why.push('contradicting/garbage client provider not announced');
  if (!exp.providerAnnounced && provStatus) why.push('matching/absent provider announced as stale');
  return { ok: why.length === 0, why, observed: { provider: cfg?.provider, model: cfg?.effective?.model ?? null, overridden: cfg?.overridden, ignored: cfg?.ignoredOverrides, statuses: statuses.filter((s) => /model|provider/i.test(s)).map((s) => s.slice(0, 90)) } };
}

/** THE surfaces grader: one state, painted everywhere. */
function gradeSurfaces(s, E, read) {
  const why = [];
  const want = read === 'ok' ? E : null;
  const pressed = (list) => list.filter((b) => b.pressed === 'true').map((b) => b.k);
  if (s.view !== want) why.push(`providerView ${s.view} ≠ ${want}`);
  if (s.btn.hidden) why.push('#provBtn hidden');
  if (s.btn.locked !== 'true') why.push(`#provBtn data-locked=${s.btn.locked}`);
  if (s.btn.provider !== (want ?? 'unknown')) why.push(`#provBtn data-provider=${s.btn.provider}`);
  if (want == null && !/not known yet/i.test(s.btn.title ?? '')) why.push('#provBtn title does not say the engine is unknown');
  if (want != null && !(s.btn.title ?? '').includes(`runs on ${NAME[E]}`)) why.push('#provBtn title does not explain the lock');
  if (!(s.pop.opts.length === 2 && s.pop.opts.every((o) => o.disabled))) why.push(`popover options not all disabled ${JSON.stringify(s.pop.opts)}`);
  if (JSON.stringify(pressed(s.pop.opts)) !== JSON.stringify(want ? [want] : [])) why.push(`popover pressed ${JSON.stringify(pressed(s.pop.opts))}`);
  if (!s.pop.note) why.push('popover carries no explanation');
  if (!(s.drawer.btns.length === 2 && s.drawer.btns.every((b) => b.disabled))) why.push(`drawer buttons not all disabled ${JSON.stringify(s.drawer.btns)}`);
  if (JSON.stringify(pressed(s.drawer.btns)) !== JSON.stringify(want ? [want] : [])) why.push(`drawer pressed ${JSON.stringify(pressed(s.drawer.btns))}`);
  if (!s.drawer.warn) why.push('drawer carries no explanation');
  // agreement: the three lock surfaces say the same thing
  if (s.btn.provider !== (pressed(s.pop.opts)[0] ?? 'unknown') || s.btn.provider !== (pressed(s.drawer.btns)[0] ?? 'unknown')) why.push('button, popover and drawer disagree');
  // The row that merely SHOWS the user's current armed pick (FEAT-118 renders an
  // off-catalog current value as its own row) is state, not an offer — exact text.
  const offered = s.modelRows.filter((n) => n !== s.armedModel);
  const claudeRows = offered.filter((n) => /^(opus|sonnet|haiku|fable|default)/i.test(n) || /claude/i.test(n));
  const codexRows = offered.filter((n) => /gpt|codex/i.test(n));
  if (want == null && offered.some((n) => !/project default/i.test(n))) why.push(`engine unknown but the model popover offers ${JSON.stringify(offered)}`);
  if (want === 'openai' && claudeRows.length) why.push(`Codex session offered Claude models ${JSON.stringify(claudeRows)}`);
  if (want === 'anthropic' && codexRows.length) why.push(`Claude session offered Codex models ${JSON.stringify(codexRows)}`);
  if (s.drawerModels) {
    if (!s.drawerModels.length) why.push('drawer session-scope model row not found');
    const bad = s.drawerModels.filter((v) => v != null && (want == null || ENGINE_OF(v) === OTHER[want]));
    if (bad.length) why.push(`drawer model row offers ${JSON.stringify(bad)} for engine ${want ?? 'unknown'}`);
  }
  return { ok: why.length === 0, why };
}

// ---------------------------------------------------------------------------
let server = null, browser = null;

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

async function unitLeg() {
  console.log('\n--- UNIT: the one model→engine classifier (global-settings.modelProviderOf)');
  const U = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug196m-unit-'));
  const ids = [...new Set([...Object.values(VALID), ...Object.values(VALID2), 'opus', 'sonnet', 'haiku', 'fable', 'default', 'opusplan', 'opus[1m]', 'sonnet[1m]', 'claude-fable-5-1[1m]', 'gpt-6-astra', 'o3', 'codex-mini', GARBAGE, 'mystery-model-z'])];
  const run = (label) => new Promise((resolve) => {
    const code = `const m = await import(${JSON.stringify('file://' + path.join(ROOT, 'src', 'server', 'global-settings.ts'))});` +
      `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(ids)}.map((i) => [i, m.modelProviderOf(i)]))));`;
    const c = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, CLAUDE_STATION_DATA: U }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', () => {});
    c.on('close', () => { try { resolve(JSON.parse(out.trim().split('\n').pop())); } catch { resolve({ __error: out.slice(0, 200), label }); } });
  });
  const bare = await run('no catalog');
  // A COPY of the user's real catalogs (read-only source; the copy is scratch).
  const realData = process.env.CLAUDE_STATION_DATA_REAL ?? path.join(os.homedir(), '.local', 'share', 'claude-station');
  let copied = 0;
  for (const f of ['models.json', 'models-openai.json']) {
    try { fs.copyFileSync(path.join(realData, f), path.join(U, f)); copied++; } catch { /* absent on this machine */ }
  }
  const withCat = await run('real catalog copy');
  for (const id of ids) {
    const want = ENGINE_OF(id);
    check(`unit: modelProviderOf(${id}) = ${want} with NO catalog`, bare[id] === want, { got: bare[id] });
    check(`unit: modelProviderOf(${id}) = ${want} with the REAL catalog (${copied} file(s) copied)`, withCat[id] === want, { got: withCat[id] });
  }
  check('unit: the real catalog files were found and copied (else the second pass proves nothing)', copied === 2, { copied, realData });
  fs.rmSync(U, { recursive: true, force: true });
}

async function main() {
  console.log(`\n========== BUG-196 round 6 — the lock MATRIX (tree: ${ROOT === REPO ? 'working tree' : ROOT}) ==========`);
  console.log(`legs=${LEGS} engines=${ENGINES} reads=${READS}`);

  // ---- synthesized must-FAIL: the five round-5 breaks, as constructed observations.
  {
    const e1 = expectFor('openai', 'claude-opus-4-1', { provider: 'anthropic', model: 'claude-opus-4-1' }, undefined);
    const b1 = gradeServer([{ t: 'effective-config', provider: 'openai', effective: { model: null }, overridden: [], ignoredOverrides: [] }], e1, 'claude-opus-4-1');
    const e2 = expectFor('openai', 'opus', { provider: 'anthropic', model: null }, undefined);
    const b2 = gradeServer([{ t: 'effective-config', provider: 'openai', effective: { model: 'opus' }, overridden: ['model'], ignoredOverrides: [] }], e2, 'opus');
    const failedReadSurf = (over) => ({ view: null, btn: { hidden: false, locked: 'true', provider: 'unknown', title: 'Engine: not known yet — …' },
      pop: { opts: [{ k: 'anthropic', pressed: 'false', disabled: true }, { k: 'openai', pressed: 'false', disabled: true }], note: 'set by its transcript' },
      drawer: { btns: [{ k: 'anthropic', pressed: 'false', disabled: true }, { k: 'openai', pressed: 'false', disabled: true }], warn: 'set by its transcript' },
      modelRows: ['Project default'], ...over });
    const control = gradeSurfaces(failedReadSurf({}), 'openai', 'failed');
    const b3 = gradeSurfaces(failedReadSurf({ modelRows: ['Project default', 'Opus', 'Sonnet', 'Haiku'] }), 'openai', 'failed');
    const e4 = expectFor('openai', null, { provider: 'anthropic', model: null }, 'gemini');
    const b4 = gradeServer([{ t: 'error', fatal: true, message: 'start.overrides rejected: provider must be one of anthropic, openai' }], e4, null);
    const b5 = gradeSurfaces(failedReadSurf({ view: 'anthropic', btn: { hidden: false, locked: 'false', provider: 'anthropic', title: 'Provider: Claude (project default) — applies when the next session starts. Click to change' },
      pop: { opts: [{ k: 'anthropic', pressed: 'true', disabled: true }, { k: 'openai', pressed: 'false', disabled: true }], note: 'set by its transcript' },
      drawer: { btns: [{ k: 'anthropic', pressed: 'true', disabled: true }, { k: 'openai', pressed: 'false', disabled: true }], warn: 'set by its transcript' } }), 'openai', 'failed');
    check('MUST-FAIL (synthesized, round-5 break 1): an invalid pick equal to the project default, dropped silently, is graded FAIL', !b1.ok, b1.why);
    check('MUST-FAIL (synthesized, round-5 break 2): a Claude alias handed to Codex with no word is graded FAIL', !b2.ok, b2.why);
    check('MUST-FAIL (synthesized, round-5 break 3): Opus/Sonnet/Haiku offered after a failed read of a Codex thread is graded FAIL', !b3.ok && control.ok, { b3: b3.why, control: control.why });
    check('MUST-FAIL (synthesized, round-5 break 4): a fatal rejection of provider "gemini" on a resume is graded FAIL', !b4.ok, b4.why);
    check('MUST-FAIL (synthesized, round-5 break 5): #provBtn unlocked showing "Claude (project default)" after a failed read is graded FAIL', !b5.ok, b5.why);
  }

  if (LEGS.includes('unit')) await unitLeg();
  if (!LEGS.includes('wire') && !LEGS.includes('client') && !LEGS.includes('fresh') && !LEGS.includes('order')) return;

  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  server = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE,
      CLAUDE_STATION_CODEX_BIN: FAKE_CODEX, CODEX_HOME, CLAUDE_STATION_CLAUDE_BIN: CLAUDE_STUB,
      CLAUDE_STATION_SURVIVE: '0', CLAUDE_CONFIG_DIR: CLAUDE_CFG, ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_API_KEY: '',
    },
    stdio: ['ignore', 'ignore', 'pipe'], detached: true,
  });
  server.stderr?.on('data', (d) => { if (VERBOSE) process.stderr.write(`  [server!] ${d}`); });
  let up = false;
  for (let i = 0; i < 150 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(200); } }
  if (!up) throw new Error('server never became healthy');

  // ---- projects: one per distinct project-settings value the selected cells need.
  const projects = new Map(); // key → { id, dir, enc, name }
  const projFor = async (settings) => {
    const key = JSON.stringify(settings);
    if (projects.has(key)) return projects.get(key);
    const dir = fs.mkdtempSync(path.join(PROJ_ROOT, 'p-'));
    const name = `b196m${projects.size}x${Date.now().toString(36)}`;
    const r = await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: dir, name, applyMethod: false, isolation: 'direct' }) });
    if (!r.ok) throw new Error(`register ${name}: ${await r.text()}`);
    const id = (await r.json()).project.id;
    const pr = await fetch(`${BASE}/api/projects/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ settings }) });
    if (!pr.ok) throw new Error(`settings ${name} ${key}: ${await pr.text()}`);
    const got = await (await fetch(`${BASE}/api/projects/${id}`)).json();
    const gs = got?.project?.settings ?? got?.settings ?? {};
    const iso = got?.project?.isolation ?? got?.isolation;
    if ((gs.provider ?? 'anthropic') !== settings.provider || (gs.model ?? null) !== settings.model || iso !== 'direct') throw new Error(`project ${name} did not take ${key}: ${JSON.stringify({ gs, iso })}`);
    const p = { id, dir, enc: encodeCwd(dir), name, settings };
    projects.set(key, p);
    return p;
  };
  const now = new Date().toISOString();
  const writeTranscript = (E, p, id) => {
    if (E === 'openai') {
      const d = path.join(DATA, 'transcripts', 'openai', p.enc);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, `${id}.jsonl`), [
        { type: 'user', message: { role: 'user', content: 'tighten the lexer' }, sessionId: id, cwd: p.dir, timestamp: now, provider: 'openai' },
        { type: 'assistant', message: { role: 'assistant', model: 'gpt-5-codex', content: [{ type: 'text', text: 'Done.' }] }, sessionId: id, cwd: p.dir, timestamp: now, provider: 'openai' },
      ].map((l) => JSON.stringify(l)).join('\n') + '\n');
    } else {
      const d = path.join(STORE, p.enc);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, `${id}.jsonl`), [
        { type: 'user', message: { role: 'user', content: 'hello claude' }, sessionId: id, cwd: p.dir, timestamp: now, version: '2.1.0', uuid: randomUUID() },
        { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4', content: [{ type: 'text', text: 'Hi.' }] }, sessionId: id, cwd: p.dir, timestamp: now, uuid: randomUUID() },
      ].map((l) => JSON.stringify(l)).join('\n') + '\n');
    }
  };
  const cells = [];
  for (const E of ENGINES) for (const pk of PICKS) for (const pj of PROJS) for (const rd of READS) for (const cp of CPROVS) cells.push({ E, pk, pj, rd, cp });
  if (args.limit) cells.splice(Number(args.limit));
  // BUG-196 round 7 — narrow the matrix to a slice and repeat it (the flake-vs-race
  // investigation ran alias·openai·read=ok ≥30×): --pick= --project= --cprov= --repeat=N.
  for (const [flag, field] of [['pick', 'pk'], ['project', 'pj'], ['cprov', 'cp']]) {
    if (args[flag]) { const keep = String(args[flag]).split(','); for (let i = cells.length - 1; i >= 0; i--) if (!keep.includes(cells[i][field])) cells.splice(i, 1); }
  }
  if (args.repeat) { const once = cells.slice(); for (let r = 1; r < Number(args.repeat); r++) cells.push(...once.map((c) => ({ ...c }))); }
  for (const c of cells) { c.pick = pickValue(c.E, c.pk); c.proj = projSettings(c.E, c.pj, c.pick); c.P = await projFor(c.proj); }

  const readLines = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
  /** Wire proof that the turn REACHED the engine (Codex: its input log, with ASSERT_MODEL
   *  in the prompt making a wrong model a fatal; Claude: the stub's argv, incl. --model). */
  const reachedNow = (E, id, prompt) => {
    if (E === 'openai') return { reached: readLines(CODEX_INPUT).some((l) => l.includes(prompt)) };
    const line = readLines(CLAUDE_ARGV).map((l) => { try { return JSON.parse(l); } catch { return []; } }).find((a) => a.some((x) => typeof x === 'string' && x.includes(id)));
    if (!line) return { reached: false, argvSeen: readLines(CLAUDE_ARGV).length };
    const eq = line.find((x) => typeof x === 'string' && x.startsWith('--model='));
    const i = line.indexOf('--model');
    return { reached: true, model: eq ? eq.slice('--model='.length) : i >= 0 ? line[i + 1] : null };
  };

  // ======================================================================= WIRE
  if (LEGS.includes('wire')) {
    console.log('\n--- WIRE: raw start frames, client provider ON THE WIRE (the server is the only judge)');
    /** One real start. The socket is HELD open until `reached()` (the turn reached the
     *  engine) or a fatal or the deadline — closing it early makes the server close a
     *  session still starting, so the engine would never be spawned. */
    const runStart = async (frame, reached, ms = 15000) => {
      const t0 = Date.now();
      for (;;) {
        const events = await new Promise((resolve) => {
          const evs = [];
          const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
          let finished = false;
          const done = () => { if (finished) return; finished = true; clearTimeout(t); clearInterval(iv); try { ws.close(); } catch { /* */ } resolve(evs); };
          const t = setTimeout(done, ms);
          let reachedAt = 0;
          const iv = setInterval(() => {
            if (!evs.some((e) => e.t === 'effective-config')) return;
            if (!reachedAt && reached()) reachedAt = Date.now();
            if (reachedAt && Date.now() - reachedAt > 500) done(); // let an engine-side violation surface
          }, 100);
          ws.onopen = () => ws.send(JSON.stringify(frame));
          ws.onmessage = (m) => {
            let e; try { e = JSON.parse(String(m.data)); } catch { return; }
            evs.push(e);
            if (e.t === 'error' && e.fatal) setTimeout(done, 150);
          };
          ws.onerror = () => { evs.push({ t: 'ws-error' }); done(); };
        });
        if (events.some((e) => e.code === 'runtime-check-pending') && Date.now() - t0 < 60000) { await sleep(1000); continue; }
        return events;
      }
    };
    const seen = new Set();
    let n = 0, okN = 0;
    const wireCell = async (E, pk, pj, cpLabel, cpVal, P, pick, proj) => {
      const id = randomUUID();
      writeTranscript(E, P, id);
      const ov = {};
      if (pick != null) ov.model = pick;
      if (cpLabel !== 'absent') ov.provider = cpVal;
      const exp = expectFor(E, pick, proj, cpLabel === 'absent' ? undefined : cpVal);
      const prompt = exp.model != null && E === 'openai' ? `ASSERT_MODEL:${exp.model}; wire ${id}` : `wire ${id}`;
      if (E === 'openai') fs.writeFileSync(RESUME_EXPECT, id);
      const evs = await runStart({ type: 'start', projectId: P.id, resumeSessionId: id, resumeEncodedDir: P.enc, prompt, ...(Object.keys(ov).length ? { overrides: ov } : {}) },
        () => reachedNow(E, id, prompt).reached);
      const g = gradeServer(evs, exp, pick);
      const w = g.ok ? reachedNow(E, id, prompt) : { reached: 'skipped' };
      if (g.ok && E === 'anthropic' && w.reached && (w.model ?? null) !== exp.model) g.why.push(`Claude engine received --model ${w.model} ≠ ${exp.model}`);
      if (g.ok && !w.reached) g.why.push('the turn never reached the engine');
      if (E === 'openai' && g.ok) {
        const fatalLate = evs.find((e) => e.t === 'error' && e.fatal);
        if (fatalLate) g.why.push(`engine fatal after start (ASSERT_MODEL / protocol): ${String(fatalLate.message).slice(0, 140)}`);
      }
      n++;
      const ok = g.why.length === 0;
      if (ok) okN++;
      if (!ok && VERBOSE) console.log(JSON.stringify(evs.map((e) => ({ t: e.t, s: e.status, m: e.message, c: e.code }))).slice(0, 1500));
      check(`wire [${E} · pick=${pk} · project=${pj} · clientProvider=${cpLabel}]`, ok, { why: g.why, ...g.observed });
    };
    for (const c of cells) {
      const key = `${c.E}|${c.pk}|${c.pj}|${c.cp}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await wireCell(c.E, c.pk, c.pj, c.cp, cprovValue(c.E, c.cp), c.P, c.pick, c.proj);
    }
    // Named garbage provider values on the wire (round-5 break 4's exact values + more).
    for (const E of ENGINES) {
      const proj = projSettings(E, 'other', null);
      const P = await projFor(proj);
      for (const [label, v] of [['null', null], ['"OpenAI"', 'OpenAI'], ['"gemini"', 'gemini'], ['42', 42], ['{}', {}], ['""', ''], ['["openai"]', ['openai']]]) {
        await wireCell(E, 'valid', 'other', `garbage:${label}`, v, P, VALID[E], proj);
      }
    }
    // Named boundary frames the matrix does not enumerate (BUG-196 round 6 self-attack).
    for (const E of ENGINES) {
      // (x1) a FORK of an existing session carrying garbage provider: a fork is a
      // resume of the source id, so the provider is dropped before validation too.
      if (E === 'anthropic') {
        const proj = projSettings(E, 'other', null); const P = await projFor(proj);
        const id = randomUUID(); writeTranscript(E, P, id);
        const evs = await runStart({ type: 'start', projectId: P.id, resumeSessionId: id, resumeEncodedDir: P.enc, fork: true, prompt: `fork ${id}`, overrides: { provider: 'gemini', model: VALID[E] } },
          () => reachedNow(E, id, `fork ${id}`).reached);
        const cfg = evs.find((e) => e.t === 'effective-config');
        const rej = evs.find((e) => /overrides rejected/i.test(e.message ?? ''));
        check(`wire (x1) [${E}] a FORK frame with provider "gemini" is not fatal and runs on the source's engine`,
          !rej && cfg?.provider === E && cfg?.effective?.model === VALID[E], { rej: rej?.message, provider: cfg?.provider, model: cfg?.effective?.model });
      }
      // (x2) the boundary: a FRESH start (no resumeSessionId) with a garbage provider
      // is still refused LOUDLY — a provider is a real request there, never ignored.
      const P2 = await projFor(projSettings(E, 'same', null));
      const ev2 = await runStart({ type: 'start', projectId: P2.id, prompt: 'fresh garbage provider', overrides: { provider: 'gemini' } }, () => false, 6000);
      check(`wire (x2) [${E}] boundary: a FRESH start with provider "gemini" is refused loudly (fatal, named), not silently ignored`,
        ev2.some((e) => e.t === 'error' && e.fatal && /overrides rejected: .*provider/i.test(e.message ?? '')) && !ev2.some((e) => e.t === 'effective-config'),
        ev2.filter((e) => e.t === 'error').map((e) => e.message));
    }
    console.log(`  wire: ${okN}/${n} frames hold the invariant`);
  }

  // ===================================================================== CLIENT
  if (LEGS.includes('client') || LEGS.includes('fresh') || LEGS.includes('order')) {
    console.log('\n--- CLIENT: real Brave, persisted pick + client provider, transcript read ok/failed, real submit()');
    browser = await chromium.launch({ headless: true, executablePath: process.env.QA_BRAVE_PATH ?? '/usr/bin/brave' });
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    let sent = [], got = [];
    // BUG-196 round 7 — the event ORDER of every /api/transcript/ request, printed on a failed cell.
    let tx = []; const tx0 = { t: Date.now() };
    page.on('request', (r) => { if (r.url().includes('/api/transcript/')) tx.push({ at: Date.now() - tx0.t, ev: 'req', url: r.url().replace(/^.*\/api\/transcript\//, '').slice(0, 140) }); });
    page.on('response', async (r) => {
      if (!r.url().includes('/api/transcript/')) return;
      let lp; try { lp = (await r.json())?.lockedProvider; } catch { lp = '(unreadable)'; }
      tx.push({ at: Date.now() - tx0.t, ev: 'res', status: r.status(), lockedProvider: lp, url: r.url().replace(/^.*\/api\/transcript\//, '').slice(0, 140) });
    });
    const netFails = []; // every request the BROWSER failed (not an HTTP status) — the environment, not the app
    page.on('requestfailed', (r) => { const f = r.failure()?.errorText ?? ''; if (!/ERR_ABORTED/.test(f)) netFails.push(`${new Date().toISOString()} ${f} ${r.url().replace(/^https?:\/\/[^/]+/, '').slice(0, 60)}`); });
    page.on('requestfailed', (r) => { if (r.url().includes('/api/transcript/')) tx.push({ at: Date.now() - tx0.t, wall: new Date().toISOString(), ev: 'failed', err: r.failure()?.errorText, url: r.url().replace(/^.*\/api\/transcript\//, '').slice(0, 140) }); });
    page.on('websocket', (ws) => {
      ws.on('framesent', (f) => { try { sent.push(JSON.parse(String(f.payload))); } catch { /* */ } });
      ws.on('framereceived', (f) => { try { got.push(JSON.parse(String(f.payload))); } catch { /* */ } });
    });
    // BUG-196 round 7 — the round-6 clean-room CLIENT failures (119/120, and the boot
    // "waitForFunction: Timeout 30000ms" FATALs) were the BROWSER failing a request with
    // net::ERR_NETWORK_CHANGED: Chromium aborts in-flight requests whenever a host network
    // interface appears or vanishes, and other workloads on this machine create and delete
    // docker veth interfaces in bursts (ip monitor: ~1k link events in a minute, 0 when
    // idle). A transcript read the browser aborted is a FAILED read — the client then shows
    // the designed failed-read state (engine unknown, locked, explained) — so a `read=ok`
    // cell whose read the environment killed was graded against a precondition it never
    // had. The wait is now on the read's OUTCOME, not a swallowed 15 s timeout: a read the
    // browser itself failed (net::ERR_*, never an HTTP status — an app error is graded,
    // never retried) is re-run from a re-seeded page, at most ENV_TRIES times, and every
    // retry is printed. `--no-env-retry` turns the retry off; `--inject-netfail` makes the
    // browser abort the FIRST transcript read of every read=ok cell (the deterministic
    // reproduction of the clean-room signature).
    const ENV_TRIES = args['no-env-retry'] ? 1 : 3;
    const browserFailed = (f) => !!f && /^net::ERR_/.test(f) && f !== 'net::ERR_ABORTED';
    let envRetries = 0;
    const envLog = [];
    const boot = async () => {
      for (let attempt = 1; ; attempt++) {
        const mark = netFails.length;
        try {
          await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
          await page.waitForFunction(() => !!window.__station?.state?.projects?.length, null, { timeout: 30000 });
          return;
        } catch (err) {
          const env = netFails.slice(mark);
          if (!env.length || attempt >= ENV_TRIES) throw new Error(`${err.message}${env.length ? ` (browser-level failures during boot: ${env.slice(0, 3).join(' ; ')})` : ''}`);
          envRetries++; envLog.push(`boot attempt ${attempt}: ${env[0]}`);
        }
      }
    };
    /** Seed the cell's persisted state, boot, open the session; wait for the read's OUTCOME. */
    const openCell = async (c, id, key, entry) => {
      for (let attempt = 1; ; attempt++) {
        await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
        await page.evaluate(([k, v]) => {
          const all = {}; if (v) all[k] = v;
          localStorage.setItem('cs-overrides', JSON.stringify(all));
        }, [key, Object.keys(entry).length ? entry : null]);
        await boot();
        tx = []; tx0.t = Date.now();
        const isRead = (u) => u.pathname.startsWith('/api/transcript/') && u.pathname.includes(id);
        if (c.rd === 'failed') {
          await page.route(isRead, (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' }));
        } else if (args['inject-netfail'] && attempt === 1) {
          let first = true;
          await page.route(isRead, (route) => { if (first) { first = false; return route.abort('internetdisconnected'); } return route.continue(); });
        }
        await page.evaluate((a) => {
          const s = window.__station;
          void s.openSession(s.state.projects.find((x) => x.id === a.pid), { encodedDir: a.enc, sessionId: a.id, displayTitle: 'matrix', os: 'linux' });
        }, { pid: c.P.id, enc: c.P.enc, id });
        await page.waitForFunction((i) => window.__station.state.current.sessionId === i, id, { timeout: 15000 });
        // The read's outcome: the pin landed (ok), or openSession's failure path painted
        // "could not read this session" (the read failed — by the route, or by the browser).
        const outcome = await page.waitForFunction((i) => {
          if (window.__station.lockedProviderOf(i)) return 'pinned';
          return [...document.querySelectorAll('.hint-row')].some((x) => /could not read this session/.test(x.textContent ?? '')) ? 'read-failed' : false;
        }, id, { timeout: 15000 }).then((h) => h.jsonValue(), () => 'TIMEOUT (neither pinned nor failed in 15 s)');
        const envFail = tx.find((t) => t.ev === 'failed' && browserFailed(t.err));
        if (c.rd === 'ok' && outcome === 'read-failed' && envFail && attempt < ENV_TRIES) {
          envRetries++; envLog.push(`[${c.E} · pick=${c.pk} · project=${c.pj} · clientProvider=${c.cp}] read attempt ${attempt}: ${envFail.err} at ${envFail.wall}`);
          continue;
        }
        return { outcome, envFail: envFail?.err ?? null, attempts: attempt };
      }
    };
    let n = 0, okN = 0;
    await boot(); // an origin to write localStorage on
    for (const c of (LEGS.includes('client') ? cells : [])) {
      const { E, pk, pj, rd, cp, pick, proj, P } = c;
      const id = randomUUID();
      writeTranscript(E, P, id);
      const key = `${P.enc} ${id}`;
      const entry = {};
      if (pick != null) entry.model = pick;
      if (cp !== 'absent') entry.provider = cprovValue(E, cp);
      const opened = await openCell(c, id, key, entry);
      const pinWait = opened.outcome;
      // Read every lock surface from the DOM, through real clicks.
      const surf = await page.evaluate(async () => {
        const s = window.__station;
        const tick = (ms) => new Promise((r) => setTimeout(r, ms));
        const b = document.querySelector('#provBtn');
        const btn = { hidden: b.hidden, locked: b.dataset.locked, provider: b.dataset.provider, title: b.title };
        b.click(); await tick(80);
        const keys = ['anthropic', 'openai'];
        const opts = [...document.querySelectorAll('#provOpts .opt')].map((o, i) => ({ k: keys[i], pressed: o.getAttribute('aria-pressed'), disabled: o.disabled || o.getAttribute('aria-disabled') === 'true' }));
        const note = [...document.querySelectorAll('#provOpts .grp-note[data-warn="true"]')].map((x) => x.textContent).join(' ');
        document.body.click(); await tick(50);
        const mb = document.querySelector('#modelBtn');
        mb.click(); await tick(120);
        const modelRows = [...document.querySelectorAll('#modelOpts button.opt .n')].map((x) => (x.textContent || '').trim());
        document.body.click(); await tick(50);
        await s.drawer.open('settings', { scope: 'session', focus: 'provider' });
        await tick(250);
        const btns = [...document.querySelectorAll('[data-focus="provider"] .prov-seg button[data-prov]')].map((x) => ({ k: x.dataset.prov, pressed: x.getAttribute('aria-pressed'), disabled: x.disabled }));
        const warn = [...document.querySelectorAll('[data-focus="provider"] [data-warn="true"]')].map((x) => x.textContent).join(' ');
        const armedModel = s.state.overrides.model ?? null;
        // The drawer's session-scope MODEL dropdown (FEAT-159: was a click-to-cycle
        // row): pick every concrete option it offers and record the value each arms,
        // then put the armed pick back exactly.
        const drawerModels = [];
        const optCount = document.querySelectorAll('#sel-model option').length;
        for (let i = 0; i < optCount; i++) {
          const sel = document.querySelector('#sel-model');
          if (!sel) break;
          const o = sel.options[i];
          if (!o || o.value === '__custom__') continue;
          sel.value = o.value; sel.dispatchEvent(new Event('change', { bubbles: true })); await tick(60);
          drawerModels.push(s.state.overrides.model ?? null);
        }
        if (armedModel == null) delete s.state.overrides.model; else s.state.overrides.model = armedModel;
        return { view: s.providerView(), btn, pop: { opts, note }, drawer: { btns, warn }, modelRows, drawerModels, armedProvider: s.state.overrides.provider ?? null, armedModel };
      });
      // put storage back to what the app itself left after restore (the drawer clicks persisted)
      await page.evaluate(([k, m]) => {
        const all = JSON.parse(localStorage.getItem('cs-overrides') ?? '{}');
        if (m == null) { if (all[k]) { delete all[k].model; if (!Object.keys(all[k]).length) delete all[k]; } }
        else all[k] = { ...(all[k] ?? {}), model: m };
        localStorage.setItem('cs-overrides', JSON.stringify(all));
      }, [key, surf.armedModel]);
      await page.keyboard.press('Escape').catch(() => {});
      await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
      const gs = gradeSurfaces(surf, E, rd);
      const why = [...gs.why];
      if (surf.armedProvider != null) why.push(`a persisted provider was re-armed (${surf.armedProvider})`);
      if ((surf.armedModel ?? null) !== (pick ?? null)) why.push(`the persisted pick was not restored (${surf.armedModel})`);
      // A REAL send.
      sent = []; got = [];
      if (E === 'openai') fs.writeFileSync(RESUME_EXPECT, id);
      await page.evaluate(() => { document.querySelector('#prompt').value = 'continue'; void window.__station.submit(); });
      const t0 = Date.now();
      while (Date.now() - t0 < 20000 && !got.some((e) => e.t === 'effective-config' || (e.t === 'error' && e.fatal && e.code !== 'runtime-check-pending'))) await sleep(100);
      await sleep(300);
      const frame = sent.find((f) => f.type === 'start' && f.resumeSessionId === id) ?? null;
      if (!frame) why.push('no start frame was sent');
      else {
        if (frame.overrides && 'provider' in frame.overrides) why.push(`the resume frame carried provider ${JSON.stringify(frame.overrides.provider)}`);
        if ((frame.overrides?.model ?? null) !== (pick ?? null)) why.push(`the client judged the pick: sent model ${JSON.stringify(frame.overrides?.model ?? null)} ≠ ${JSON.stringify(pick)}`);
      }
      const exp = expectFor(E, pick, proj, undefined);
      const gsv = gradeServer(got, exp, pick);
      why.push(...gsv.why.map((w) => `server: ${w}`));
      const after = await page.evaluate((k) => {
        let saved = null; try { saved = JSON.parse(localStorage.getItem('cs-overrides') ?? '{}')[k] ?? null; } catch { saved = 'UNPARSEABLE'; }
        return { mem: window.__station.state.overrides.model ?? null, saved };
      }, key);
      if (after.saved && typeof after.saved === 'object' && 'provider' in after.saved) why.push('a provider is still persisted after the send');
      const wantModelAfter = exp.pickVerdict === 'ignored' ? null : (pick ?? null);
      if (after.mem !== wantModelAfter || (after.saved?.model ?? null) !== wantModelAfter) why.push(`after the server's verdict the pick is ${JSON.stringify(after)} (want ${JSON.stringify(wantModelAfter)})`);
      n++;
      const ok = why.length === 0;
      if (ok) okN++;
      check(`client [${E} · pick=${pk} · project=${pj} · read=${rd} · clientProvider=${cp}]`, ok, { why, server: gsv.observed, ...(ok ? {} : { pinWait, trace: tx.slice(0, 12) }) });
    }
    if (LEGS.includes('client')) console.log(`  client: ${okN}/${n} cells hold the invariant`);
    console.log(`  environment retries (browser-level read/boot failures, re-run — never an app error): ${envRetries}${envLog.length ? '\n    ' + envLog.slice(0, 20).join('\n    ') : ''}`);
    console.log(`  browser-level request failures (environment): ${netFails.length}${netFails.length ? '\n    ' + netFails.slice(0, 20).join('\n    ') : ''}`);

    // ------------------------------------------------------------------ ORDER
    // BUG-196 round 7 — the race hypothesis, FORCED rather than waited for. Two orderings:
    //  (late) the transcript read is HELD for ORDER_DELAY ms, so every lock surface paints
    //    the UNKNOWN state first — button read, provider popover left OPEN, Settings drawer
    //    left OPEN — and the pin lands afterwards with no user action. Graded: the "before"
    //    snapshot really was unknown (the ordering happened), and the "after" snapshot of the
    //    SAME open surfaces is the pinned engine, locked, explained. A paint that ran before
    //    the declaration and never re-ran would leave "after" = "before".
    //  (netfail) the read is ABORTED by the browser (net::ERR_INTERNET_DISCONNECTED, the
    //    same class as the clean room's ERR_NETWORK_CHANGED). Graded: the surfaces show the
    //    exact clean-room signature — which grades FAIL as `read=ok` and PASS as `read=failed`
    //    (the designed failed-read state) — and a real submit() then converges them on the
    //    engine the server declares (session-init), i.e. "unknown" does not stick.
    if (LEGS.includes('order')) {
      console.log('\n--- ORDER: forced orderings — pin lands AFTER the surfaces painted; read aborted by the browser');
      const ORDER_DELAY = Number(args['order-delay'] ?? 2500);
      const snap = () => page.evaluate(() => {
        const s = window.__station;
        const b = document.querySelector('#provBtn');
        const pop = document.querySelector('#provPop');
        const keys = ['anthropic', 'openai'];
        return {
          view: s.providerView(),
          btn: { hidden: b.hidden, locked: b.dataset.locked, provider: b.dataset.provider, title: b.title },
          popOpen: !!pop?.classList.contains('open'),
          pop: [...document.querySelectorAll('#provOpts .opt')].map((o, i) => ({ k: keys[i], pressed: o.getAttribute('aria-pressed'), disabled: o.disabled || o.getAttribute('aria-disabled') === 'true' })),
          popNote: [...document.querySelectorAll('#provOpts .grp-note[data-warn="true"]')].map((x) => x.textContent).join(' '),
          drawer: [...document.querySelectorAll('[data-focus="provider"] .prov-seg button[data-prov]')].map((x) => ({ k: x.dataset.prov, pressed: x.getAttribute('aria-pressed'), disabled: x.disabled })),
          drawerWarn: [...document.querySelectorAll('[data-focus="provider"] [data-warn="true"]')].map((x) => x.textContent).join(' '),
        };
      });
      const pressedOf = (l) => l.filter((b) => b.pressed === 'true').map((b) => b.k);
      /** One snapshot of the open surfaces against ONE expected engine (null = unknown). */
      const gradeSnap = (sn, want, E) => {
        const why = [];
        if (sn.view !== want) why.push(`providerView ${sn.view} ≠ ${want}`);
        if (sn.btn.locked !== 'true') why.push(`#provBtn data-locked=${sn.btn.locked}`);
        if (sn.btn.provider !== (want ?? 'unknown')) why.push(`#provBtn data-provider=${sn.btn.provider}`);
        if (want == null ? !/not known yet/i.test(sn.btn.title) : !sn.btn.title.includes(`runs on ${NAME[E]}`)) why.push(`#provBtn title ${JSON.stringify(sn.btn.title.slice(0, 60))}`);
        if (!sn.popOpen) why.push('provider popover not open');
        if (JSON.stringify(pressedOf(sn.pop)) !== JSON.stringify(want ? [want] : [])) why.push(`open popover pressed ${JSON.stringify(pressedOf(sn.pop))}`);
        if (!(sn.pop.length === 2 && sn.pop.every((o) => o.disabled))) why.push('open popover options not all disabled');
        if (want != null && !sn.popNote.includes(NAME[E])) why.push('open popover note does not name the engine');
        if (JSON.stringify(pressedOf(sn.drawer)) !== JSON.stringify(want ? [want] : [])) why.push(`open drawer pressed ${JSON.stringify(pressedOf(sn.drawer))}`);
        if (!(sn.drawer.length === 2 && sn.drawer.every((b) => b.disabled))) why.push('open drawer buttons not all disabled');
        if (want != null && !sn.drawerWarn.includes(NAME[E])) why.push('open drawer warning does not name the engine');
        return why;
      };
      // Non-vacuity of the (late) grader, on a synthesized "painted once, never repainted"
      // observation: the after-snapshot equal to the unknown before-snapshot must FAIL.
      {
        const stuck = { view: null, btn: { hidden: false, locked: 'true', provider: 'unknown', title: 'Engine: not known yet — …' }, popOpen: true,
          pop: [{ k: 'anthropic', pressed: 'false', disabled: true }, { k: 'openai', pressed: 'false', disabled: true }], popNote: 'has not been read yet',
          drawer: [{ k: 'anthropic', pressed: 'false', disabled: true }, { k: 'openai', pressed: 'false', disabled: true }], drawerWarn: 'has not been read yet' };
        check('ORDER MUST-FAIL (synthesized): surfaces painted unknown before the pin and NEVER repainted are graded FAIL', gradeSnap(stuck, 'openai', 'openai').length > 0 && gradeSnap(stuck, null, 'openai').length === 0, null);
      }
      const orderPicks = String(args['order-picks'] ?? 'alias,none,valid').split(',');
      const orderShapes = [['same', 'absent'], ['other', 'garbage']];
      let on = 0, ook = 0;
      for (const E of ENGINES) for (const pk of orderPicks) for (const [pj, cp] of orderShapes) for (const mode of ['late', 'netfail']) {
        const pick = pickValue(E, pk);
        const proj = projSettings(E, pj, pick);
        const P = await projFor(proj);
        const id = randomUUID();
        writeTranscript(E, P, id);
        const key = `${P.enc} ${id}`;
        const entry = {};
        if (pick != null) entry.model = pick;
        if (cp !== 'absent') entry.provider = cprovValue(E, cp);
        await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
        await page.evaluate(([k, v]) => { const all = {}; if (v) all[k] = v; localStorage.setItem('cs-overrides', JSON.stringify(all)); }, [key, Object.keys(entry).length ? entry : null]);
        await boot();
        tx = []; tx0.t = Date.now();
        const isRead = (u) => u.pathname.startsWith('/api/transcript/') && u.pathname.includes(id);
        let released = 0;
        if (mode === 'late') await page.route(isRead, async (route) => { await sleep(ORDER_DELAY); released = Date.now(); await route.continue(); });
        else await page.route(isRead, (route) => route.abort('internetdisconnected'));
        await page.evaluate((a) => {
          const s = window.__station;
          void s.openSession(s.state.projects.find((x) => x.id === a.pid), { encodedDir: a.enc, sessionId: a.id, displayTitle: 'matrix-order', os: 'linux' });
        }, { pid: P.id, enc: P.enc, id });
        await page.waitForFunction((i) => window.__station.state.current.sessionId === i, id, { timeout: 15000 });
        // Open BOTH lock surfaces while the engine is still undeclared, and leave them open.
        await page.evaluate(async () => {
          const s = window.__station;
          document.querySelector('#provBtn').click();
          await new Promise((r) => setTimeout(r, 80));
          await s.drawer.open('settings', { scope: 'session', focus: 'provider' });
          await new Promise((r) => setTimeout(r, 250));
        });
        const why = [];
        if (mode === 'late') {
          const before = await snap();
          const pinnedBefore = await page.evaluate((i) => window.__station.lockedProviderOf(i), id);
          if (pinnedBefore != null || released) why.push(`ordering NOT forced: the pin (${pinnedBefore}) landed before the surfaces were read`);
          why.push(...gradeSnap(before, null, E).map((w) => `before: ${w}`));
          const landed = await page.waitForFunction(([i, e]) => window.__station.lockedProviderOf(i) === e, [id, E], { timeout: ORDER_DELAY + 10000 }).then(() => true, () => false);
          if (!landed) why.push('the pin never landed after the held read was released');
          await sleep(150); // no user action — only the declaration's own repaint
          const after = await snap();
          why.push(...gradeSnap(after, E, E).map((w) => `after: ${w}`));
          if (why.length) why.push(`trace ${JSON.stringify(tx.slice(0, 4))}`);
        } else {
          await page.waitForFunction(() => [...document.querySelectorAll('.hint-row')].some((x) => /could not read this session/.test(x.textContent ?? '')), null, { timeout: 15000 }).catch(() => why.push('the aborted read never reached the failure path'));
          const sn = await snap();
          const asOk = gradeSnap(sn, E, E), asFailed = gradeSnap(sn, null, E);
          const sig = sn.view === null && sn.btn.provider === 'unknown';
          if (!(asOk.length > 0 && sig)) why.push(`the aborted read did NOT reproduce the clean-room signature (view=${sn.view}, btn=${sn.btn.provider})`);
          if (asFailed.length) why.push(...asFailed.map((w) => `as the designed failed-read state: ${w}`));
          // …and it does not stick: a real send makes the server declare the engine.
          await page.keyboard.press('Escape').catch(() => {});
          await page.evaluate(() => window.__station.drawer.close?.());
          sent = []; got = [];
          if (E === 'openai') fs.writeFileSync(RESUME_EXPECT, id);
          await page.evaluate(() => { document.querySelector('#prompt').value = 'continue'; void window.__station.submit(); });
          const t0 = Date.now();
          while (Date.now() - t0 < 20000 && !got.some((e) => e.t === 'session-init' || (e.t === 'error' && e.fatal && e.code !== 'runtime-check-pending'))) await sleep(100);
          await sleep(300);
          const init = got.find((e) => e.t === 'session-init');
          const conv = await page.evaluate((i) => ({ pin: window.__station.lockedProviderOf(i), view: window.__station.providerView() }), id);
          // The Claude engine here is a stub that exits before it can emit session-init, so
          // for anthropic only the view (fed by effective-config's running engine) is gradable;
          // the pin-by-session-init convergence is proven on the openai (fake app-server) cells.
          if (E === 'openai') {
            if (!init) why.push(`no session-init after the send (${JSON.stringify(got.filter((e) => e.t === 'error').map((e) => e.message)).slice(0, 160)})`);
            else if (init.lockedProvider !== E) why.push(`session-init declared ${init.lockedProvider} ≠ ${E}`);
            if (conv.pin !== E) why.push(`after session-init the pin is ${conv.pin} (want ${E})`);
          }
          if (conv.view !== E) why.push(`after the server answered, the client still reads ${JSON.stringify(conv)} (want ${E})`);
        }
        await page.keyboard.press('Escape').catch(() => {});
        await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
        on++; if (!why.length) ook++;
        check(`order [${E} · pick=${pk} · project=${pj} · clientProvider=${cp} · ${mode === 'late' ? `pin lands ${ORDER_DELAY} ms AFTER the surfaces painted` : 'read aborted by the browser, then a real send'}]`, !why.length, why);
      }
      console.log(`  order: ${ook}/${on} forced-ordering cells converge on the declared engine`);
    }

    // ------------------------------------------------------------------ FRESH
    // BUG-196 round 6 deleted the client's model classifier, so a FRESH start's
    // cross-engine pick is now judged by the server too (it used to be dropped by
    // the client). Engine {openai, anthropic} × via {project default, armed override
    // through pickProvider} × pick {none, valid, other, alias, garbage} = 20 cells,
    // real submit(). The pick is written where the model popover writes it
    // (state.overrides.model) — a pending-new view has no storage key yet.
    if (LEGS.includes('fresh')) {
      console.log('\n--- FRESH: new sessions, real submit(), the server judges the pick and the client heals on its word');
      let fn = 0, fok = 0;
      for (const E of ENGINES) for (const via of ['project', 'armed']) for (const pk of PICKS) {
        const pick = pickValue(E, pk);
        const proj = via === 'project' ? projSettings(E, 'same', null) : projSettings(E, 'other', null);
        const P = await projFor(proj);
        await boot();
        const setup = await page.evaluate((a) => {
          const s = window.__station;
          s.startNew(a.pid);
          let armed = true;
          if (a.via === 'armed') armed = s.pickProvider(a.E) === true;
          if (a.pick != null) s.state.overrides.model = a.pick;
          return { armed, view: s.providerView(), refusal: s.providerSwitchRefusal() };
        }, { pid: P.id, via, E, pick });
        sent = []; got = [];
        await page.evaluate(() => { document.querySelector('#prompt').value = 'fresh'; void window.__station.submit(); });
        const t0 = Date.now();
        while (Date.now() - t0 < 20000 && !got.some((e) => e.t === 'effective-config' || (e.t === 'error' && e.fatal && e.code !== 'runtime-check-pending'))) await sleep(100);
        await sleep(400);
        const why = [];
        if (!setup.armed || setup.view !== E || setup.refusal !== null) why.push(`setup: ${JSON.stringify(setup)}`);
        const frame = sent.find((f) => f.type === 'start' && !f.resumeSessionId) ?? null;
        if (!frame) why.push('no start frame');
        else {
          if ((frame.overrides?.model ?? null) !== (pick ?? null)) why.push(`the client judged the pick: sent ${JSON.stringify(frame.overrides?.model ?? null)}`);
          if (via === 'armed' && frame.overrides?.provider !== E) why.push(`armed provider not sent (${JSON.stringify(frame.overrides?.provider)})`);
        }
        const exp = expectFor(E, pick, proj, undefined);
        const g = gradeServer(got, exp, pick);
        why.push(...g.why.map((w) => `server: ${w}`));
        const mem = await page.evaluate(() => window.__station.state.overrides.model ?? null);
        const wantMem = exp.pickVerdict === 'ignored' ? null : (pick ?? null);
        if (mem !== wantMem) why.push(`after the server's verdict the armed pick is ${JSON.stringify(mem)} (want ${JSON.stringify(wantMem)})`);
        fn++; if (!why.length) fok++;
        check(`fresh [${E} · via=${via} · pick=${pk}]`, !why.length, { why, server: g.observed });
      }
      console.log(`  fresh: ${fok}/${fn} cells hold the invariant`);
    }
    check('client: no page errors across the whole run', pageErrors.length === 0, pageErrors.slice(0, 5));
  }
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.stack ?? err.message}`);
  process.exitCode = 1;
}).finally(async () => {
  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed (${fail}): ${failures.slice(0, 40).join(' | ')}${fail > 40 ? ' | …' : ''}`);
  process.exitCode = fail ? 1 : (process.exitCode ?? 0);
  try { await browser?.close(); } catch { /* closed */ }
  try { if (server?.pid) process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ }
  await sleep(300);
  // Reap ONLY processes whose environment names this run's own scratch data dir.
  try {
    for (const pid of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
      let env = '';
      try { env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8'); } catch { continue; }
      if (env.split('\0').includes(`CLAUDE_STATION_DATA=${DATA}`) && Number(pid) !== process.pid) { try { process.kill(Number(pid), 'SIGKILL'); } catch { /* gone */ } }
    }
  } catch { /* no /proc */ }
  for (const d of [DATA, STORE, CODEX_HOME, CLAUDE_CFG, PROJ_ROOT]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  setTimeout(() => process.exit(process.exitCode ?? 0), 300).unref();
});
