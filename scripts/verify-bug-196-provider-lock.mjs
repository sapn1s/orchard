/**
 * BUG-196 — a session switched to Claude keeps resuming on OpenAI, and every UI
 * surface still says Claude (the switch silently does nothing).
 *
 * Root cause (diagnosed on the ticket): the engine a resume runs on is OWNED by
 * the transcript — a Codex/OpenAI thread id can only continue on Codex, a Claude
 * file only on Claude. agent-bridge P2b applies exactly that on every resume
 * (silently), while the UI's per-session provider indicator re-derives the engine
 * from the project setting / a per-session override the resume ignores. Two places
 * hold a different answer for "which engine runs next" (ARCH-010 violation).
 *
 * Option A (this fix, no context carry): make the transcript-owned engine the ONE
 * fact every surface reads. The server resolves it once (resumeProviderOf, the
 * SAME resolver P2b uses) and declares it on the transcript response
 * (`lockedProvider`). The client reads only that: the per-session provider
 * indicator shows the real engine, and the provider selector is DISABLED with a
 * short explanation for any session already pinned by its transcript — exactly the
 * refusal a LIVE session already gives, extended to a resumable-from-disk one.
 *
 * USER-OBSERVABLE verification — a REAL headless browser (Brave) against a REAL
 * server on a free port, isolated data + transcript stores (never the user's), and
 * a REAL OpenAI transcript on disk (the artifact whose provider dir pins the
 * engine). The project default is Claude (anthropic) — the exact conflict the user
 * hit.
 *
 *   - MUST-FAIL (synthesized pre-fix): the pre-fix client had no lockedProvider —
 *     providerView() re-derived the engine from project/override. Reproduce that by
 *     removing the session id's entry from the pin store (round 3: lockedProviders,
 *     keyed by session id; rounds 1-2: state.current.lockedProvider) and asserting the openai session
 *     then reads as anthropic with a SWITCHABLE selector — the silent-divergence bug.
 *   - FIXED: openSession() fetches the real transcript; the server declares
 *     lockedProvider='openai' from the on-disk artifact. providerView()==='openai',
 *     the selector popover options are DISABLED, and it carries the "runs on OpenAI
 *     Codex — start a new session to use Claude" explanation. pickProvider() refuses.
 *   - CONTROL: a fresh (pending-new) session has no transcript → not locked →
 *     providerView() is the project default and the selector is switchable
 *     (pickProvider('openai') arms the override and the view follows it).
 *
 * The must-FAIL baseline is a CONSTRUCTED pre-fix state (lockedProvider forced
 * null), anchored to a fixed variable, not a moving reference; it is non-vacuous
 * because the same real openai transcript is on disk in both renders — the only
 * thing that differs is whether the client reads the server's lockedProvider.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug196-data-'));   // station data (transcripts/openai lives here)
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug196-store-')); // isolated Claude store (NOT ~/.claude)
const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug196-proj-'));   // the project's host dir
const PROJ2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug196-proj2-')); // a SECOND project whose default engine is OpenAI (case d)
const PROJ_NAME = `bug196proj${Date.now().toString(36)}`;
// BUG-196 round 4 — the server alone decides a resumed session's engine. These
// stores back the cases that run a REAL start through the real bridge: a DIRECT
// project (no container), the scripted fake Codex app-server as the openai engine,
// a scratch $CODEX_HOME holding a NATIVE, never-imported rollout, and — so the
// mirror case's Claude CLI can never reach the API or spend quota — an empty
// scratch CLAUDE_CONFIG_DIR plus a dead ANTHROPIC_BASE_URL.
const PROJ3 = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug196-proj3-')); // direct, default Claude — native Codex rollouts + stale-override race
const PROJ4 = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug196-proj4-')); // direct, default OpenAI — the mirror (native Claude transcript)
const CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug196-codexhome-'));
const CLAUDE_CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug196-claudecfg-'));
const CODEX_MARK = path.join(DATA, 'codex-exec-marker.log');
const FAKE_CODEX_REAL = path.join(ROOT, 'scripts', 'fixtures', 'codex-fake-app-server.mjs');
// The fake app-server accepts exactly ONE thread id on thread/resume (a resume
// into any other thread is a protocol VIOLATION, exit 1). This wrapper pins it,
// per run, to the session id the case is resuming — so a run that reaches
// session-init PROVES the resume continued that very Codex thread.
const RESUME_EXPECT = path.join(DATA, 'codex-expect-resume');
const FAKE_CODEX = path.join(DATA, 'codex-fake-wrapper.mjs');
fs.writeFileSync(FAKE_CODEX,
  `import * as fs from 'node:fs';\n` +
  `try { process.env.CODEX_FAKE_EXPECT_RESUME = fs.readFileSync(${JSON.stringify(RESUME_EXPECT)}, 'utf8').trim(); } catch { /* none */ }\n` +
  // BUG-196 round 5 — the fake logs every turn/start prompt it received, so (l1)
  // can prove the resumed turn REACHED the engine (and its ASSERT_MODEL check ran).
  `process.env.CODEX_FAKE_INPUT_LOG = ${JSON.stringify(path.join(DATA, 'codex-input.log'))};\n` +
  `await import(${JSON.stringify('file://' + FAKE_CODEX_REAL)});\n`);
const encodeCwd = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  const line = typeof observed === 'string' ? observed : JSON.stringify(observed);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${line}`);
  ok ? pass++ : (fail++, failures.push(name));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

let server = null, browser = null;

async function main() {
  console.log('\n========== BUG-196 — a transcript-pinned session shows its REAL engine and the selector refuses a switch ==========');
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;

  // BUG-196 round 4 — NATIVE Codex rollouts in $CODEX_HOME, in the real on-disk
  // shape ($CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl, session_meta
  // first — shape mirrored from a real rollout, values synthetic). Never imported:
  // no Orchard transcript exists for them until something opens or resumes them.
  const rolloutDir = path.join(CODEX_HOME, 'sessions', '2026', '09', '29');
  fs.mkdirSync(rolloutDir, { recursive: true });
  const writeRollout = (id, n) => {
    const ts = new Date().toISOString();
    const lines = [
      { timestamp: ts, type: 'session_meta', payload: { session_id: id, id, timestamp: ts, cwd: PROJ3, originator: 'codex_cli_rs', cli_version: '0.160.0', source: 'cli', model_provider: 'openai' } },
      { timestamp: ts, type: 'turn_context', payload: { model: 'gpt-5-codex', cwd: PROJ3 } },
      { timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `native codex task ${n}` }] } },
      { timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'On it.' }] } },
    ];
    fs.writeFileSync(path.join(rolloutDir, `rollout-2026-09-29T10-0${n}-00-${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  };
  const NAT_A = randomUUID(); // never opened, never imported — the round-3 break
  const NAT_B = randomUUID(); // imported by one transcript GET first — round 3 then REJECTED the identical frame
  writeRollout(NAT_A, 1);
  writeRollout(NAT_B, 2);

  server = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE,
      // BUG-196 round 4 — real starts (cases i–k): fake Codex, scratch codex store,
      // no survival scopes, and a Claude CLI that cannot authenticate or reach the API.
      CLAUDE_STATION_CODEX_BIN: FAKE_CODEX, CODEX_HOME, CODEX_FAKE_EXEC_MARKER: CODEX_MARK,
      CLAUDE_STATION_SURVIVE: '0', CLAUDE_CONFIG_DIR: CLAUDE_CFG, ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_API_KEY: '',
    },
    stdio: ['ignore', 'ignore', 'pipe'], detached: true,
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 100 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(200); } }
  if (!up) throw new Error('server never became healthy');

  // Register the project. Its default engine is Claude (anthropic) — no provider
  // override, so the registry default applies. This is the user's exact conflict:
  // project says Claude, the session's transcript says OpenAI.
  const reg = await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: PROJ, name: PROJ_NAME, applyMethod: false }),
  });
  if (!reg.ok) throw new Error(`could not register project: ${await reg.text()}`);
  const P_ID = (await reg.json()).project.id;

  // Confirm the project default is Claude (the "switched to Claude" side of the bug).
  const proj = await (await fetch(`${BASE}/api/projects/${P_ID}`)).json();
  const projProvider = proj?.project?.settings?.provider ?? proj?.settings?.provider ?? 'anthropic';
  check('precondition: project default engine is Claude (anthropic)', (projProvider ?? 'anthropic') === 'anthropic',
    `settings.provider=${JSON.stringify(projProvider)}`);

  // Write a REAL OpenAI transcript on disk, under the Orchard openai provider dir —
  // the artifact that pins the engine. resolveOrchardSessionFile keys off exactly
  // this directory, so the server will resolve lockedProvider='openai' for it.
  const OAI_ID = randomUUID();
  const enc = encodeCwd(PROJ);
  const oaiDir = path.join(DATA, 'transcripts', 'openai', enc);
  fs.mkdirSync(oaiDir, { recursive: true });
  const now = new Date().toISOString();
  const oaiLines = [
    { type: 'user', message: { role: 'user', content: 'summarise the repo' }, sessionId: OAI_ID, cwd: PROJ, timestamp: now, version: '2.1.0', entrypoint: 'sdk-ts' },
    { type: 'assistant', message: { role: 'assistant', model: 'gpt-5-codex', content: [{ type: 'text', text: 'Working on it.' }] }, sessionId: OAI_ID, cwd: PROJ, timestamp: now },
  ];
  fs.writeFileSync(path.join(oaiDir, `${OAI_ID}.jsonl`), oaiLines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  // The SERVER declares the locked engine on the transcript response (ARCH-010 —
  // single owner). Prove that before touching the UI.
  const tail = await (await fetch(`${BASE}/api/transcript/${encodeURIComponent(enc)}/${encodeURIComponent(OAI_ID)}?tail=50`)).json();
  check('the server declares lockedProvider=openai for the on-disk OpenAI transcript (single owner)',
    tail.lockedProvider === 'openai', `lockedProvider=${JSON.stringify(tail.lockedProvider)}`);

  // ---- boot the REAL page in a real headless browser (system Brave; never download).
  browser = await chromium.launch({ headless: true, executablePath: process.env.QA_BRAVE_PATH ?? '/usr/bin/brave' });
  const page = await browser.newPage();
  page.on('pageerror', (e) => process.stderr.write(`  [pageerror] ${e.message}\n`));
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction((name) => {
    const s = window.__station;
    if (!s) return false;
    return [...document.querySelectorAll('#tree button.proj')].some(
      (n) => (n.querySelector('.nm')?.textContent || '').trim() === name);
  }, PROJ_NAME, { timeout: 30000 });

  // Open the real OpenAI session (drives the real transcript fetch → lockedProvider).
  await page.evaluate((args) => {
    const s = window.__station;
    const p = s.state.projects.find((x) => x.id === args.pid);
    return s.openSession(p, { encodedDir: args.enc, sessionId: args.id, displayTitle: 'summarise the repo', os: 'linux' });
  }, { pid: P_ID, enc, id: OAI_ID });
  await page.waitForFunction((id) => window.__station.state.current.sessionId === id, OAI_ID, { timeout: 15000 });
  await page.waitForFunction(() => window.__station.lockedSessionProvider() != null, null, { timeout: 15000 })
    .catch(() => {});

  // ---- MUST-FAIL (synthesized pre-fix): the pre-fix client had no lockedProvider,
  // so providerView() re-derived from project/override → 'anthropic', and the
  // selector was switchable. Reproduce that exact state by clearing the field.
  const pre = await page.evaluate(() => {
    const s = window.__station;
    // Round 3: the pin lives in the id-keyed store (lockedProviders), written only
    // from server declarations. Remove THIS id's entry = the pre-fix world.
    const id = s.state.current.sessionId;
    const saved = s.lockedProviders.get(id);
    s.lockedProviders.delete(id); // the pre-fix world: the fact did not exist
    const view = s.providerView();
    const locked = s.lockedSessionProvider ? s.lockedSessionProvider() : null;
    s.lockedProviders.set(id, saved); // restore for the fixed assertions below
    return { view, locked };
  });
  // BUG-196 round 6 — these synthesized baselines remove the pin from the CURRENT
  // code, so they move with it: since round 6 an id with no declared engine reads
  // as UNKNOWN (null), never as the project default. Re-anchored to the property the
  // FIXED checks need — without the server's pin the view cannot name the real
  // engine — which still fails the fixed assertion (view === 'openai').
  check('MUST-FAIL (pre-fix synthesized): without lockedProvider the OpenAI session cannot show its real engine (pre-fix: anthropic; round 6: unknown)',
    pre.view !== 'openai' && pre.locked === null,
    `providerView=${pre.view} lockedSessionProvider=${pre.locked}`);

  // ---- FIXED: the real transcript makes the server declare openai; every surface
  // reads it. providerView is openai; the selector is disabled + explained.
  const fixed = await page.evaluate(() => {
    const s = window.__station;
    return {
      lockedField: s.lockedProviderOf(s.state.current.sessionId),
      view: s.providerView(),
      locked: s.lockedSessionProvider ? s.lockedSessionProvider() : 'MISSING',
    };
  });
  check('FIXED: state carries the server-declared lockedProvider=openai',
    fixed.lockedField === 'openai', `lockedProvider=${fixed.lockedField}`);
  check('FIXED: providerView() shows the REAL engine (openai), not the project default',
    fixed.view === 'openai', `providerView=${fixed.view} lockedSessionProvider=${fixed.locked}`);

  // The selector popover: open it via the real button and assert the options are
  // disabled and the explanation is present.
  const pop = await page.evaluate(() => {
    const s = window.__station;
    const btn = document.querySelector('#provBtn');
    if (!btn || btn.hidden) return { shown: false };
    btn.click();
    const opts = [...document.querySelectorAll('#provOpts .opt')];
    const notes = [...document.querySelectorAll('#provOpts .grp-note')].map((n) => n.textContent || '');
    return {
      shown: true,
      optCount: opts.length,
      allDisabled: opts.length > 0 && opts.every((o) => o.disabled || o.getAttribute('aria-disabled') === 'true'),
      explain: notes.find((t) => /new session/i.test(t)) || '',
    };
  });
  check('FIXED: the provider selector popover options are DISABLED for a transcript-pinned session',
    pop.shown && pop.allDisabled, `shown=${pop.shown} optCount=${pop.optCount} allDisabled=${pop.allDisabled}`);
  check('FIXED: the popover explains the lock ("start a new session" to use the other engine)',
    /new session/i.test(pop.explain) && /openai|codex/i.test(pop.explain),
    `explain=${JSON.stringify(pop.explain)}`);

  // pickProvider must REFUSE and leave the view unchanged.
  const refuse = await page.evaluate(() => {
    const s = window.__station;
    const before = s.providerView();
    s.pickProvider('anthropic'); // attempt the exact switch the user tried
    return { before, after: s.providerView(), overrideArmed: 'provider' in s.state.overrides };
  });
  check('FIXED: pickProvider() refuses the switch — the view stays on the real engine, no override armed',
    refuse.after === 'openai', `before=${refuse.before} after=${refuse.after} overrideArmed=${refuse.overrideArmed}`);

  // ---- CONTROL: a fresh (pending-new) session has no transcript → switchable.
  await page.evaluate((pid) => window.__station.startNew(pid), P_ID);
  await sleep(150);
  const control = await page.evaluate(() => {
    const s = window.__station;
    const locked = s.lockedSessionProvider ? s.lockedSessionProvider() : 'MISSING';
    const viewDefault = s.providerView();
    s.pickProvider('openai'); // arming the override must WORK on a fresh session
    const viewAfter = s.providerView();
    return { locked, viewDefault, viewAfter, armed: 'provider' in s.state.overrides };
  });
  check('CONTROL: a fresh session is NOT locked and starts on the project default (Claude)',
    control.locked === null && control.viewDefault === 'anthropic',
    `locked=${control.locked} viewDefault=${control.viewDefault}`);
  check('CONTROL: a fresh session is switchable — pickProvider("openai") arms the override and the view follows',
    control.viewAfter === 'openai' && control.armed === true,
    `viewAfter=${control.viewAfter} armed=${control.armed}`);

  // ============================================================================
  // (a) BUG-196 round 2 — the NEW-SESSION-FIRST-TURN entry path (the case the
  //     round-1 fix missed). A session begun as NEW in the tab runs its first
  //     turn: session-init makes it real WITHOUT going through openSession's
  //     transcript fetch. The server declares the engine it dispatched on
  //     (session-init.lockedProvider); the client must lock every provider surface
  //     to it. Round 1 left pendingNew set + lockedProvider null → the surfaces
  //     fell back to project/override and ACCEPTED a switch the resume ignores.
  // ============================================================================

  // MUST-FAIL (constructed pre-fix state, anchored to fixed values — NOT a moving
  // baseline): the OLD session-init handler set state.current.sessionId but neither
  // cleared pendingNew nor recorded lockedProvider. Reproduce that exact state for a
  // new session the SERVER dispatched on OpenAI, and assert the UI reads the project
  // default (anthropic/Claude) and pickProvider('anthropic') is ACCEPTED — the silent
  // divergence: UI says Claude, the real (server-declared) engine is OpenAI.
  const NEW_ID = randomUUID();
  const preNew = await page.evaluate((args) => {
    const s = window.__station;
    s.startNew(args.pid);                       // a genuine pending-new view
    // The pre-fix handler, faithfully: id set, pendingNew LEFT set, lockedProvider NEVER recorded.
    s.state.current.sessionId = args.id;
    s.state.current.encodedDir = args.enc;
    // (state.pendingNew stays === pid; state.current.lockedProvider stays undefined/null)
    return {
      view: s.providerView(),
      locked: s.lockedSessionProvider(),
      pendingNew: s.state.pendingNew === args.pid,
      accepted: (() => { s.pickProvider('anthropic'); return s.providerView(); })(),
    };
  }, { pid: P_ID, id: NEW_ID, enc });
  // BUG-196 round 6 — re-anchored like the reopen baseline above: without the pin
  // the view cannot name the real engine (round 6 shows it unknown and refuses the
  // switch, so "accepts a switch" is no longer reproducible from current code).
  check('MUST-FAIL (a, pre-fix synthesized): a new OpenAI session made real by its first turn, pin missing, cannot show its real engine',
    preNew.view !== 'openai' && preNew.locked === null,
    `view=${preNew.view} locked=${preNew.locked} pendingNewStillSet=${preNew.pendingNew} afterSwitch=${preNew.accepted}`);

  // FIXED: drive the REAL live-event dispatcher with the session-init frame the
  // server now emits (lockedProvider='openai' — the engine the bridge dispatched on).
  const NEW_ID2 = randomUUID();
  const fixedNew = await page.evaluate((args) => {
    const s = window.__station;
    s.startNew(args.pid); // fresh pending-new, so pickProvider('anthropic') below would be honored if unlocked
    s.onEvent({
      t: 'session-init', sessionId: args.id, cwd: args.proj, model: 'gpt-5-codex',
      tools: [], permissionMode: 'default', slashCommands: [], lockedProvider: 'openai',
    });
    const before = s.providerView();
    s.pickProvider('anthropic'); // the exact switch the user tried
    return {
      lockedField: s.lockedProviderOf(s.state.current.sessionId),
      pendingCleared: s.state.pendingNew === null,
      locked: s.lockedSessionProvider(),
      view: before,
      afterSwitch: s.providerView(),
      overrideArmed: 'provider' in s.state.overrides,
    };
  }, { pid: P_ID, id: NEW_ID2, proj: PROJ });
  check('FIXED (a): session-init records the server-declared lockedProvider=openai and marks the session real',
    fixedNew.lockedField === 'openai' && fixedNew.pendingCleared === true && fixedNew.locked === 'openai',
    `lockedField=${fixedNew.lockedField} pendingCleared=${fixedNew.pendingCleared} lockedSessionProvider=${fixedNew.locked}`);
  check('FIXED (a): a new OpenAI session shows its REAL engine and REFUSES the switch to Claude',
    fixedNew.view === 'openai' && fixedNew.afterSwitch === 'openai' && fixedNew.overrideArmed === false,
    `view=${fixedNew.view} afterSwitch=${fixedNew.afterSwitch} overrideArmed=${fixedNew.overrideArmed}`);

  // ============================================================================
  // (d) THE REVERSE — an Anthropic thread under an OpenAI-default project. The
  //     lock must follow the TRANSCRIPT, not the project default: this session
  //     shows Claude and refuses a switch to OpenAI, even though its project
  //     defaults to OpenAI. Guards against a fix that merely inverts the bug.
  // ============================================================================
  const reg2 = await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: PROJ2, name: `${PROJ_NAME}b`, applyMethod: false }),
  });
  if (!reg2.ok) throw new Error(`could not register project 2: ${await reg2.text()}`);
  const P2_ID = (await reg2.json()).project.id;
  // Flip project 2's default engine to OpenAI.
  const patch = await fetch(`${BASE}/api/projects/${P2_ID}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { provider: 'openai' } }),
  });
  if (!patch.ok) throw new Error(`could not set project 2 provider: ${await patch.text()}`);
  const proj2 = await (await fetch(`${BASE}/api/projects/${P2_ID}`)).json();
  const p2Provider = proj2?.project?.settings?.provider ?? proj2?.settings?.provider;
  check('precondition (d): project 2 default engine is OpenAI', p2Provider === 'openai', `settings.provider=${JSON.stringify(p2Provider)}`);

  // A REAL Anthropic transcript in the Claude store (CLAUDE_PROJECTS_DIR) — an
  // Orchard-owned OpenAI dir is deliberately ABSENT, so resumeProviderOf falls to
  // the Claude store's only resumable engine: 'anthropic'.
  const ANT_ID = randomUUID();
  const enc2 = encodeCwd(PROJ2);
  const claudeDir = path.join(STORE, enc2);
  fs.mkdirSync(claudeDir, { recursive: true });
  const antLines = [
    { type: 'user', message: { role: 'user', content: 'hello claude' }, sessionId: ANT_ID, cwd: PROJ2, timestamp: now, version: '2.1.0' },
    { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4', content: [{ type: 'text', text: 'Hi.' }] }, sessionId: ANT_ID, cwd: PROJ2, timestamp: now },
  ];
  fs.writeFileSync(path.join(claudeDir, `${ANT_ID}.jsonl`), antLines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  const tail2 = await (await fetch(`${BASE}/api/transcript/${encodeURIComponent(enc2)}/${encodeURIComponent(ANT_ID)}?tail=50`)).json();
  check('(d) the server declares lockedProvider=anthropic for the Claude-store transcript (single owner, ignores the OpenAI project default)',
    tail2.lockedProvider === 'anthropic', `lockedProvider=${JSON.stringify(tail2.lockedProvider)}`);

  // Project 2 was registered over the API after the page loaded — reload so the
  // client's tree learns about it, then wait for its nav row.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction((name) => {
    const s = window.__station;
    if (!s) return false;
    return [...document.querySelectorAll('#tree button.proj')].some(
      (n) => (n.querySelector('.nm')?.textContent || '').trim() === name);
  }, `${PROJ_NAME}b`, { timeout: 30000 });
  await page.evaluate((args) => {
    const s = window.__station;
    const p = s.state.projects.find((x) => x.id === args.pid);
    return s.openSession(p, { encodedDir: args.enc, sessionId: args.id, displayTitle: 'hello claude', os: 'linux' });
  }, { pid: P2_ID, enc: enc2, id: ANT_ID });
  await page.waitForFunction((id) => window.__station.state.current.sessionId === id, ANT_ID, { timeout: 15000 });
  await page.waitForFunction(() => window.__station.lockedSessionProvider() != null, null, { timeout: 15000 }).catch(() => {});

  const reverse = await page.evaluate(() => {
    const s = window.__station;
    const before = s.providerView();
    s.pickProvider('openai'); // attempt to switch this Claude thread to OpenAI
    return {
      lockedField: s.lockedProviderOf(s.state.current.sessionId),
      locked: s.lockedSessionProvider(),
      view: before,
      afterSwitch: s.providerView(),
      overrideArmed: 'provider' in s.state.overrides,
    };
  });
  check('(d) an Anthropic thread under an OpenAI-default project locks to anthropic and shows Claude, NOT the project default',
    reverse.lockedField === 'anthropic' && reverse.locked === 'anthropic' && reverse.view === 'anthropic',
    `lockedField=${reverse.lockedField} lockedSessionProvider=${reverse.locked} view=${reverse.view}`);
  check('(d) the reverse switch (to OpenAI) is REFUSED — the view stays on Claude, no override armed',
    reverse.afterSwitch === 'anthropic' && reverse.overrideArmed === false,
    `afterSwitch=${reverse.afterSwitch} overrideArmed=${reverse.overrideArmed}`);

  // ============================================================================
  // BUG-196 round 3 — the lock is a fact about a SESSION ID, not about the view.
  // Rounds 1 and 2 stored it on transient view state and gated readers on view
  // predicates (pendingNew, dockIsForeign), so each new UI state made it vanish.
  // These cases are written against USER-VISIBLE surfaces only (the #provBtn
  // attributes, the real popover DOM, pickProvider, the persisted cs-overrides
  // localStorage entry) so they grade the same way before and after the fix.
  // ============================================================================
  const OVR_KEY_A = `${enc} ${OAI_ID}`;
  const readSurfaces = () => page.evaluate((key) => {
    const s = window.__station;
    const btn = document.querySelector('#provBtn');
    // Open the popover through the REAL button (its click handler repaints it).
    const pop = document.querySelector('#provPop');
    if (pop?.classList.contains('open')) btn?.click(); // close first so the click re-opens + repaints
    btn?.click();
    const opts = [...document.querySelectorAll('#provOpts .opt')];
    const notes = [...document.querySelectorAll('#provOpts .grp-note')].map((n) => n.textContent || '');
    const pressed = opts.find((o) => o.getAttribute('aria-pressed') === 'true');
    const out = {
      foreign: s.dockIsForeign(),
      view: s.providerView(),
      btnShown: !!btn && !btn.hidden,
      btnProvider: btn?.dataset.provider ?? null,
      btnLocked: btn?.dataset.locked ?? null,
      popDisabled: opts.length > 0 && opts.every((o) => o.disabled),
      popPressed: pressed ? (pressed.querySelector('.n')?.textContent ?? '') : null,
      explain: notes.find((t) => /new session/i.test(t)) || '',
    };
    if (pop?.classList.contains('open')) btn?.click(); // leave it closed
    return out;
  }, OVR_KEY_A);
  // A pickProvider attempt made the way a user makes it: click the "Claude" row in
  // the real popover if it is clickable, else call pickProvider (the refusal path).
  const attemptClaude = () => page.evaluate((key) => {
    const s = window.__station;
    const btn = document.querySelector('#provBtn');
    btn?.click();
    const claude = [...document.querySelectorAll('#provOpts .opt')]
      .find((o) => /Claude/.test(o.querySelector('.n')?.textContent ?? ''));
    let via = 'pickProvider';
    if (claude && !claude.disabled) { claude.click(); via = 'click'; } else s.pickProvider('anthropic');
    if (document.querySelector('#provPop')?.classList.contains('open')) btn?.click();
    let persisted = null;
    try { persisted = JSON.parse(localStorage.getItem('cs-overrides') ?? '{}')[key] ?? null; } catch { persisted = 'UNPARSEABLE'; }
    return { via, view: s.providerView(), memArmed: 'provider' in s.state.overrides, persisted };
  }, OVR_KEY_A);
  const clickProject = (name) => page.evaluate((nm) => {
    const head = [...document.querySelectorAll('#tree button.proj')]
      .find((n) => (n.querySelector('.nm')?.textContent || '').trim() === nm);
    if (!head) return false;
    head.click();
    return true;
  }, name);
  const persistedProvider = (p) => p && typeof p === 'object' && 'provider' in p;

  // ---- (e) THE ROUND-2 BREAK: open the locked OpenAI session in project A
  // (default Claude), then click project B (default OpenAI — the verifier's worst
  // case: picking Claude there differs from B's default, so it would be ARMED).
  await page.evaluate(() => localStorage.removeItem('cs-overrides'));
  await page.evaluate((args) => {
    const s = window.__station;
    const p = s.state.projects.find((x) => x.id === args.pid);
    return s.openSession(p, { encodedDir: args.enc, sessionId: args.id, displayTitle: 'summarise the repo', os: 'linux' });
  }, { pid: P_ID, enc, id: OAI_ID });
  await page.waitForFunction(() => window.__station.lockedSessionProvider() === 'openai', null, { timeout: 15000 }).catch(() => {});
  const own = await readSurfaces();
  check('(e) precondition: with its own project selected the OpenAI session is locked on every surface',
    !own.foreign && own.view === 'openai' && own.btnLocked === 'true' && own.popDisabled,
    own);
  if (!(await clickProject(`${PROJ_NAME}b`))) throw new Error('project B header not found in the sidebar');
  await sleep(150);
  const e1 = await readSurfaces();
  check('(e) precondition: a real sidebar click on project B leaves A\'s session open in a FOREIGN dock',
    e1.foreign === true, `dockIsForeign=${e1.foreign}`);
  check('(e) after clicking another project the indicator still shows the session\'s REAL engine (openai), locked',
    e1.view === 'openai' && e1.btnProvider === 'openai' && e1.btnLocked === 'true',
    `view=${e1.view} btn.provider=${e1.btnProvider} btn.locked=${e1.btnLocked}`);
  check('(e) after clicking another project the popover stays locked: options disabled, OpenAI pressed, lock explained',
    e1.popDisabled && /OpenAI/.test(e1.popPressed ?? '') && /new session/i.test(e1.explain),
    `popDisabled=${e1.popDisabled} pressed=${JSON.stringify(e1.popPressed)} explain=${JSON.stringify(e1.explain.slice(0, 60))}`);
  check('(e) the button and the popover never contradict (data-locked mirrors the popover\'s disabled state)',
    (e1.btnLocked === 'true') === e1.popDisabled, `btn.locked=${e1.btnLocked} popDisabled=${e1.popDisabled}`);
  const e2 = await attemptClaude();
  check('(e) a Claude pick from the foreign view is REFUSED and nothing is persisted under the locked session\'s key',
    e2.view === 'openai' && e2.memArmed === false && !persistedProvider(e2.persisted),
    e2);

  // MUST-FAIL (e, synthesized, anchored to a constructed state — not to HEAD): the
  // round-2 break was the pin being UNREADABLE from the foreign view. Construct
  // exactly that (drop this id's pin from the store while B is selected) and show
  // the persisted-file check above does detect the defect: the Claude pick is
  // accepted and lands under the LOCKED session's own key. Then re-declare the pin
  // the way the server does and prove the heal removes it again.
  // BUG-196 round 4 — removing the pin no longer reproduces the round-2 world by
  // itself: an existing session id now refuses a pick and never persists a
  // provider even BEFORE its pin lands (the pre-pin window was round 3's gap). So
  // the round-2 writer is constructed directly — the exact state its
  // pickProvider + persistOverrides produced (provider armed in memory and written
  // under the LOCKED key) — and the same persisted-file check must flag it.
  const synth = await page.evaluate((args) => {
    const s = window.__station;
    const saved = s.lockedProviders.get(args.id);
    s.lockedProviders.delete(args.id); // pin not readable here
    s.paintProvPop();
    s.pickProvider('anthropic');
    let unpinnedPersisted = null;
    try { unpinnedPersisted = JSON.parse(localStorage.getItem('cs-overrides') ?? '{}')[args.key] ?? null; } catch { unpinnedPersisted = 'UNPARSEABLE'; }
    const unpinned = { memArmed: 'provider' in s.state.overrides, persisted: unpinnedPersisted };
    // the round-2 writer, constructed:
    s.state.overrides.provider = 'anthropic';
    const all = JSON.parse(localStorage.getItem('cs-overrides') ?? '{}');
    all[args.key] = { ...(all[args.key] ?? {}), provider: 'anthropic' };
    localStorage.setItem('cs-overrides', JSON.stringify(all));
    let persisted = null;
    try { persisted = JSON.parse(localStorage.getItem('cs-overrides') ?? '{}')[args.key] ?? null; } catch { persisted = 'UNPARSEABLE'; }
    const broken = { view: s.providerView(), persisted, unpinned };
    s.declareLockedProvider(args.id, saved); // the server's declaration — heals memory + storage
    let after = null;
    try { after = JSON.parse(localStorage.getItem('cs-overrides') ?? '{}')[args.key] ?? null; } catch { after = 'UNPARSEABLE'; }
    return { broken, healed: { view: s.providerView(), persisted: after, memArmed: 'provider' in s.state.overrides } };
  }, { id: OAI_ID, key: OVR_KEY_A });
  check('MUST-FAIL (e, synthesized): the round-2 writer\'s state (Claude armed + PERSISTED under the locked key) is flagged by the persisted-file check',
    synth.broken.view !== 'openai' && persistedProvider(synth.broken.persisted), synth.broken); // BUG-196 round 6 — unknown (null) since round 6, see the reopen baseline
  check('(e) round 4: even with the pin unreadable, a Claude pick on an existing session id is refused and nothing is persisted',
    synth.broken.unpinned.memArmed === false && !persistedProvider(synth.broken.unpinned.persisted), synth.broken.unpinned);
  check('(e) re-declaring the pin heals it: the wrongly persisted provider is removed from storage and memory',
    synth.healed.view === 'openai' && !persistedProvider(synth.healed.persisted) && synth.healed.memArmed === false, synth.healed);

  // ---- (f) two projects, switched back and forth. The lock is a property of the
  // session id, so every leg must read identically and no leg may persist a switch.
  const legs = [];
  for (const target of [PROJ_NAME, `${PROJ_NAME}b`, PROJ_NAME, `${PROJ_NAME}b`, PROJ_NAME]) {
    await clickProject(target);
    await sleep(120);
    const r = await readSurfaces();
    const a = await attemptClaude();
    legs.push({ target: target === PROJ_NAME ? 'A' : 'B', foreign: r.foreign, view: r.view, btnLocked: r.btnLocked,
      btnProvider: r.btnProvider, popDisabled: r.popDisabled, after: a.view, persisted: persistedProvider(a.persisted) });
  }
  check('(f) A↔B switched five times: every leg shows openai, locked, with button and popover agreeing',
    legs.every((l) => l.view === 'openai' && l.btnProvider === 'openai' && l.btnLocked === 'true' && l.popDisabled),
    legs.map((l) => `${l.target}:${l.foreign ? 'foreign' : 'own'}:${l.view}/${l.btnLocked}/${l.popDisabled}`).join(' '));
  check('(f) A↔B switched five times: no leg accepts or persists a switch to Claude',
    legs.every((l) => l.after === 'openai' && !l.persisted),
    legs.map((l) => `${l.target}:after=${l.after} persisted=${l.persisted}`).join(' '));

  // ---- (g) CLEANUP of an override ALREADY persisted by the round-2 bug path. Seed
  // the exact entry that path wrote (provider under the LOCKED session's own key,
  // next to a legitimate armed field), reopen the session, and it must be healed:
  // provider gone, the unrelated armed field kept.
  await page.evaluate((key) => {
    localStorage.setItem('cs-overrides', JSON.stringify({ [key]: { provider: 'anthropic', permissionMode: 'plan' } }));
  }, OVR_KEY_A);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__station?.state?.projects?.length, null, { timeout: 30000 });
  await page.evaluate((args) => {
    const s = window.__station;
    const p = s.state.projects.find((x) => x.id === args.pid);
    return s.openSession(p, { encodedDir: args.enc, sessionId: args.id, displayTitle: 'summarise the repo', os: 'linux' });
  }, { pid: P_ID, enc, id: OAI_ID });
  await page.waitForFunction(() => window.__station.lockedSessionProvider() === 'openai', null, { timeout: 15000 }).catch(() => {});
  await sleep(100);
  const healed = await page.evaluate((key) => {
    const s = window.__station;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('cs-overrides') ?? '{}')[key] ?? null; } catch { saved = 'UNPARSEABLE'; }
    return { saved, mem: { ...s.state.overrides }, view: s.providerView() };
  }, OVR_KEY_A);
  check('(g) a wrong provider override already persisted for a locked session is removed on reopen (memory AND storage)',
    !persistedProvider(healed.saved) && !('provider' in healed.mem) && healed.view === 'openai',
    healed);
  check('(g) the cleanup keeps the session\'s other armed overrides (only the impossible provider is dropped)',
    healed.saved?.permissionMode === 'plan' && healed.mem.permissionMode === 'plan', healed);

  // ---- (h) SERVER, round 4: the server ALONE decides a resumed session's engine.
  // A stale/contradicting client provider on a resume is IGNORED — never a fatal
  // rejection (round 3 rejected it, which killed the resume of a session the user
  // never switched). Promptless starts: nothing is spawned; the frame must reach
  // the reattach step (`nothing-to-reattach`) instead of being refused at the door.
  const wsStart = (frame) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const t = setTimeout(() => { try { ws.close(); } catch { /* */ } resolve({ timeout: true }); }, 8000);
    ws.onopen = () => ws.send(JSON.stringify(frame));
    ws.onmessage = (m) => {
      let e; try { e = JSON.parse(String(m.data)); } catch { return; }
      if (e.t === 'error') { clearTimeout(t); try { ws.close(); } catch { /* */ } resolve(e); }
    };
    ws.onerror = () => { clearTimeout(t); resolve({ wsError: true }); };
  });
  const notRejected = (e) => !/overrides rejected/i.test(e.message ?? '') && e.code === 'nothing-to-reattach';
  const hBad = await wsStart({ type: 'start', projectId: P_ID, resumeSessionId: OAI_ID, resumeEncodedDir: enc, overrides: { provider: 'anthropic' } });
  check('(h) a stale provider=anthropic on a resume of the OpenAI-pinned session is IGNORED, not a fatal rejection',
    notRejected(hBad), { code: hBad.code, message: hBad.message });
  const hRev = await wsStart({ type: 'start', projectId: P2_ID, resumeSessionId: ANT_ID, resumeEncodedDir: enc2, overrides: { provider: 'openai' } });
  check('(h) the reverse — provider=openai on a resume of the Claude-pinned session — is IGNORED, not rejected',
    notRejected(hRev), { code: hRev.code, message: hRev.message });
  const hOk = await wsStart({ type: 'start', projectId: P_ID, resumeSessionId: OAI_ID, resumeEncodedDir: enc, overrides: { provider: 'openai' } });
  check('(h) CONTROL: an override that MATCHES the pinned engine reaches nothing-to-reattach',
    hOk.code === 'nothing-to-reattach', { code: hOk.code, message: hOk.message });
  const hPatch = await fetch(`${BASE}/api/sessions/${OAI_ID}?dir=${encodeURIComponent(enc)}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'anthropic' }),
  });
  const hPatchBody = await hPatch.json().catch(() => ({}));
  check('(h) anti-regression: PATCH /api/sessions/:id cannot set a provider at all (400, unknown field)',
    hPatch.status === 400 && /unknown field/i.test(hPatchBody.error ?? ''), { status: hPatch.status, error: hPatchBody.error });

  // ============================================================================
  // BUG-196 round 4 — THE SERVER ALONE DECIDES A RESUMED SESSION'S ENGINE.
  // Real starts (with a prompt) through the real ws `start` handler and the real
  // bridge, on DIRECT projects so nothing depends on a container runtime. The
  // openai engine is the scripted fake app-server, pinned per run to accept ONLY
  // a thread/resume of the session id being resumed. Graded on what the server
  // tells the client: the start ack's `effective.provider`, the `session-init`
  // frame's `lockedProvider`, and the absence of any fatal/rejection error.
  // ============================================================================
  const regDirect = async (hostPath, name, provider) => {
    const r = await fetch(`${BASE}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostPath, name, applyMethod: false, isolation: 'direct' }),
    });
    if (!r.ok) throw new Error(`could not register ${name}: ${await r.text()}`);
    const id = (await r.json()).project.id;
    if (provider) {
      const pr = await fetch(`${BASE}/api/projects/${id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ settings: { provider } }),
      });
      if (!pr.ok) throw new Error(`could not set ${name} provider: ${await pr.text()}`);
    }
    const got = await (await fetch(`${BASE}/api/projects/${id}`)).json();
    return { id, isolation: got?.project?.isolation ?? got?.isolation, provider: got?.project?.settings?.provider ?? got?.settings?.provider ?? 'anthropic' };
  };
  const P3 = await regDirect(PROJ3, `${PROJ_NAME}c`, null);       // default Claude
  const P4 = await regDirect(PROJ4, `${PROJ_NAME}d`, 'openai');   // default OpenAI
  check('precondition (i–k): two DIRECT projects — P3 defaults to Claude, P4 to OpenAI',
    P3.isolation === 'direct' && P4.isolation === 'direct' && P3.provider === 'anthropic' && P4.provider === 'openai',
    { P3, P4 });
  const enc3 = encodeCwd(PROJ3);
  const enc4 = encodeCwd(PROJ4);
  const codexRuns = () => { try { return fs.readFileSync(CODEX_MARK, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };

  /**
   * One REAL start frame. Collects every server frame until `stop(events)` holds,
   * a fatal error, or the deadline. A direct session is refused RETRYABLY while
   * the runtime boot check is pending (code runtime-check-pending) — retried on
   * that structured signal only, never on prose.
   */
  const runStart = async (frame, { expectResume = null, stop, ms = 45000 } = {}) => {
    if (expectResume) fs.writeFileSync(RESUME_EXPECT, expectResume); else { try { fs.rmSync(RESUME_EXPECT); } catch { /* none */ } }
    const t0 = Date.now();
    for (;;) {
      const events = await new Promise((resolve) => {
        const evs = [];
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
        const done = () => { clearTimeout(t); try { ws.close(); } catch { /* */ } resolve(evs); };
        const t = setTimeout(done, Math.max(1000, ms - (Date.now() - t0)));
        ws.onopen = () => ws.send(JSON.stringify(frame));
        ws.onmessage = (m) => {
          let e; try { e = JSON.parse(String(m.data)); } catch { return; }
          evs.push(e);
          if ((e.t === 'error' && e.fatal) || stop(evs)) done();
        };
        ws.onerror = () => { evs.push({ t: 'ws-error' }); done(); };
      });
      const pending = events.find((e) => e.t === 'error' && e.code === 'runtime-check-pending');
      if (pending && Date.now() - t0 < ms) { await sleep(1000); continue; }
      return events;
    }
  };
  /** The one grader for a resumed run: it went to `engine`, the server said so, nothing was rejected. */
  const gradeRun = (events, engine, { needInit = true } = {}) => {
    const ack = events.find((e) => e.t === 'ack' && e.of === 'start');
    const init = events.find((e) => e.t === 'session-init');
    const rejected = events.find((e) => e.t === 'error' && /overrides rejected/i.test(e.message ?? ''));
    const fatal = events.find((e) => e.t === 'error' && e.fatal);
    const ok = !rejected && !fatal && ack?.effective?.provider === engine && (!needInit || init?.lockedProvider === engine);
    return { ok, detail: { ackProvider: ack?.effective?.provider ?? null, initLocked: init?.lockedProvider ?? null,
      error: (rejected ?? fatal)?.message?.slice(0, 160) ?? null, statuses: events.filter((e) => e.t === 'status').map((e) => e.status).filter((x) => /engine|resum/i.test(x)).slice(0, 3) } };
  };
  const untilInit = (evs) => evs.some((e) => e.t === 'session-init' || e.t === 'turn-end');
  const untilAck = (evs) => evs.some((e) => e.t === 'ack' && e.of === 'start');

  // Synthesized must-FAIL for the grader (anchored to constructed frames, not to
  // any revision): the two round-3 outcomes and the pre-P2b "client decides" one
  // must each be graded as a failure, so a green below is not a vacuous grader.
  const synthRejected = gradeRun([{ t: 'error', fatal: true, message: 'start.overrides rejected: provider "anthropic" — session X runs on OpenAI Codex' }], 'openai');
  const synthClientWon = gradeRun([{ t: 'ack', of: 'start', effective: { provider: 'anthropic' } }, { t: 'session-init', lockedProvider: 'anthropic' }], 'openai');
  const synthMirror = gradeRun([{ t: 'ack', of: 'start', effective: { provider: 'openai' } }], 'anthropic', { needInit: false });
  check('MUST-FAIL (i–k, synthesized): the grader FAILS a fatal door rejection, a run on the client\'s stale engine, and the mirror of it',
    !synthRejected.ok && !synthClientWon.ok && !synthMirror.ok,
    { rejected: synthRejected.ok, clientWon: synthClientWon.ok, mirror: synthMirror.ok });

  // ---- (i) a NATIVE, never-imported Codex rollout + a start frame carrying
  // provider:anthropic (P3 defaults to Claude too — the user's exact conflict).
  const orchardFileOf = (id) => path.join(DATA, 'transcripts', 'openai', enc3, `${id}.jsonl`);
  check('(i) precondition: native rollout A has NO Orchard transcript (never opened, never imported)',
    !fs.existsSync(orchardFileOf(NAT_A)), orchardFileOf(NAT_A).replace(DATA, '<data>'));
  const runsBeforeA = codexRuns();
  const iA = await runStart({ type: 'start', projectId: P3.id, resumeSessionId: NAT_A, resumeEncodedDir: enc3, prompt: 'continue', overrides: { provider: 'anthropic' } },
    { expectResume: NAT_A, stop: untilInit });
  const gA = gradeRun(iA, 'openai');
  check('(i) native never-imported Codex rollout + provider:anthropic → the run goes to OpenAI and session-init says openai',
    gA.ok && codexRuns() > runsBeforeA, { ...gA.detail, codexLaunches: codexRuns() - runsBeforeA });

  // (i, second leg) the SAME frame for a native rollout that ONE transcript GET
  // already imported — round 3 fatally REJECTED this one, so the outcome depended
  // on whether the user happened to open the session first.
  const getB = await (await fetch(`${BASE}/api/transcript/${encodeURIComponent(enc3)}/${encodeURIComponent(NAT_B)}?tail=50`)).json();
  check('(i) precondition: one transcript GET imports native rollout B and declares it openai',
    fs.existsSync(orchardFileOf(NAT_B)) && getB.lockedProvider === 'openai', { imported: fs.existsSync(orchardFileOf(NAT_B)), lockedProvider: getB.lockedProvider });
  const runsBeforeB = codexRuns();
  const iB = await runStart({ type: 'start', projectId: P3.id, resumeSessionId: NAT_B, resumeEncodedDir: enc3, prompt: 'continue', overrides: { provider: 'anthropic' } },
    { expectResume: NAT_B, stop: untilInit });
  const gB = gradeRun(iB, 'openai');
  check('(i) the identical frame after an import behaves identically — runs on OpenAI, session-init openai, no rejection',
    gB.ok && codexRuns() > runsBeforeB, { ...gB.detail, codexLaunches: codexRuns() - runsBeforeB });

  // ---- (k) THE MIRROR: a native Claude transcript (Claude store) under a project
  // that defaults to OpenAI, + a start frame carrying provider:openai. The run must
  // go to Claude. The Claude CLI then fails harmlessly (scratch config, dead API
  // URL) — graded up to the start ack, which is emitted after the bridge resolved
  // its engine; Codex must never be launched for it.
  const ANT4 = randomUUID();
  fs.mkdirSync(path.join(STORE, enc4), { recursive: true });
  fs.writeFileSync(path.join(STORE, enc4, `${ANT4}.jsonl`), [
    { type: 'user', message: { role: 'user', content: 'hello claude' }, sessionId: ANT4, cwd: PROJ4, timestamp: now, version: '2.1.0', uuid: randomUUID() },
    { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4', content: [{ type: 'text', text: 'Hi.' }] }, sessionId: ANT4, cwd: PROJ4, timestamp: now, uuid: randomUUID() },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const runsBeforeK = codexRuns();
  const k = await runStart({ type: 'start', projectId: P4.id, resumeSessionId: ANT4, resumeEncodedDir: enc4, prompt: 'continue', overrides: { provider: 'openai' } },
    { stop: untilAck });
  const gK = gradeRun(k, 'anthropic', { needInit: false });
  check('(k) MIRROR: native Claude transcript + provider:openai (project default OpenAI) → the run goes to Claude, no rejection, Codex never launched',
    gK.ok && codexRuns() === runsBeforeK, { ...gK.detail, codexLaunches: codexRuns() - runsBeforeK });

  // ---- (j) THE PRE-PIN SEND RACE, driven through the real UI. A stale provider
  // override persisted for an OpenAI session (plus a legitimate model pick), the
  // transcript fetch HELD so the server's pin has not landed, and a real submit()
  // in that window. The resume must succeed on the locked engine, with no fatal.
  const OAI3 = randomUUID();
  fs.mkdirSync(path.join(DATA, 'transcripts', 'openai', enc3), { recursive: true });
  fs.writeFileSync(orchardFileOf(OAI3), [
    { type: 'user', message: { role: 'user', content: 'refactor the parser' }, sessionId: OAI3, cwd: PROJ3, timestamp: now, provider: 'openai' },
    { type: 'assistant', message: { role: 'assistant', model: 'gpt-5-codex', content: [{ type: 'text', text: 'Done.' }] }, sessionId: OAI3, cwd: PROJ3, timestamp: now, provider: 'openai' },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const KEY3 = `${enc3} ${OAI3}`;
  await page.evaluate((key) => {
    localStorage.setItem('cs-overrides', JSON.stringify({ [key]: { provider: 'anthropic', model: 'gpt-5-codex' } }));
  }, KEY3);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction((name) => {
    const s = window.__station;
    return !!s && [...document.querySelectorAll('#tree button.proj')].some((n) => (n.querySelector('.nm')?.textContent || '').trim() === name);
  }, `${PROJ_NAME}c`, { timeout: 30000 });
  const sentFrames = [], gotFrames = [];
  page.on('websocket', (ws) => {
    ws.on('framesent', (f) => { try { sentFrames.push(JSON.parse(String(f.payload))); } catch { /* */ } });
    ws.on('framereceived', (f) => { try { gotFrames.push(JSON.parse(String(f.payload))); } catch { /* */ } });
  });
  let release;
  const held = new Promise((r) => { release = r; });
  await page.route((url) => url.pathname.startsWith('/api/transcript/') && url.pathname.includes(OAI3), async (route) => {
    await held;
    try { await route.continue(); } catch { /* page moved on */ }
  });
  fs.writeFileSync(RESUME_EXPECT, OAI3);
  const window1 = await page.evaluate((args) => {
    const s = window.__station;
    const p = s.state.projects.find((x) => x.id === args.pid);
    void s.openSession(p, { encodedDir: args.enc, sessionId: args.id, displayTitle: 'refactor the parser', os: 'linux' });
    return true;
  }, { pid: P3.id, enc: enc3, id: OAI3 });
  await page.waitForFunction((id) => window.__station.state.current.sessionId === id, OAI3, { timeout: 15000 });
  const inWindow = await page.evaluate((id) => {
    const s = window.__station;
    return { pinned: s.lockedProviderOf(id), armedProvider: s.state.overrides.provider ?? null, view: s.providerView() };
  }, OAI3);
  check('(j) precondition: the send happens INSIDE the pre-pin window (transcript fetch held, no pin yet for the id)',
    window1 && inWindow.pinned === null, inWindow);
  check('(j) a stale persisted provider override is NOT re-armed for a session id that already has a transcript',
    inWindow.armedProvider === null, inWindow);
  await page.evaluate(() => {
    const s = window.__station;
    document.querySelector('#prompt').value = 'continue';
    void s.submit();
  });
  const tj = Date.now();
  while (Date.now() - tj < 45000 && !gotFrames.some((e) => e.t === 'session-init' || (e.t === 'error' && e.fatal))) {
    if (gotFrames.some((e) => e.t === 'error' && e.code === 'runtime-check-pending')) break;
    await sleep(150);
  }
  const startFrame = sentFrames.find((f) => f.type === 'start' && f.resumeSessionId === OAI3) ?? null;
  const gJ = gradeRun(gotFrames, 'openai');
  check('(j) the pre-pin send carries no stale provider override for the resumed session',
    !!startFrame && !(startFrame.overrides && 'provider' in startFrame.overrides), { overrides: startFrame?.overrides ?? null });
  check('(j) the pre-pin send RESUMES on the locked engine (openai) — no fatal error, session-init says openai',
    gJ.ok, gJ.detail);
  release();
  await page.waitForFunction((id) => window.__station.lockedProviderOf(id) === 'openai', OAI3, { timeout: 15000 }).catch(() => {});
  const afterJ = await page.evaluate((key) => {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('cs-overrides') ?? '{}')[key] ?? null; } catch { saved = 'UNPARSEABLE'; }
    return { saved, view: window.__station.providerView() };
  }, KEY3);
  check('(j) afterwards the stale provider is gone from storage, the legitimate model pick survives, and the view shows openai',
    !persistedProvider(afterJ.saved) && afterJ.saved?.model === 'gpt-5-codex' && afterJ.view === 'openai', afterJ);
  await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});

  // ============================================================================
  // BUG-196 round 5 — (l) THE MODEL FOLLOWS THE FINAL ENGINE. The bridge used to
  // resolve the model against the CONFIGURED provider before P2b flipped the engine
  // to the transcript's, so under a project whose default is the OTHER engine a
  // legitimate pick was silently dropped to null (the round-4 verifier's break 1,
  // both directions). REAL starts through the real ws handler + bridge; the fake
  // Codex app-server exits 1 (a fatal) unless the resumed turn carried the model.
  // ============================================================================
  const untilTurnEnd = (evs) => evs.some((e) => e.t === 'turn-end' || e.t === 'result');
  /** One grader: the resume ran on `engine` with exactly `model`, nothing fatal, and a
   *  kept pick is still reported as overridden; a DROPPED pick must be announced. */
  const gradeModel = (events, engine, model, { dropped = null } = {}) => {
    const ack = events.find((e) => e.t === 'ack' && e.of === 'start');
    const fatal = events.find((e) => e.t === 'error' && e.fatal && !(engine === 'anthropic' && /claude|api|auth|exit|spawn/i.test(e.message ?? '')));
    const statuses = events.filter((e) => e.t === 'status').map((e) => String(e.status));
    const announced = dropped ? statuses.some((x) => x.includes('ignored your model pick') && x.includes(dropped)) : true;
    const overridden = ack?.overridden ?? null;
    const ok = !fatal && ack?.effective?.provider === engine && (ack?.effective?.model ?? null) === model && announced
      && (dropped ? !(overridden ?? []).includes('model') : (overridden ?? []).includes('model'));
    return { ok, detail: { ackProvider: ack?.effective?.provider ?? null, ackModel: ack?.effective?.model ?? null, overridden,
      fatal: fatal?.message?.slice(0, 160) ?? null, modelStatuses: statuses.filter((x) => /model/i.test(x)).slice(0, 2) } };
  };
  // Synthesized must-FAIL (constructed frames, fixed values — not a moving revision):
  // the exact round-4 outcome (pick silently dropped: model null, still "overridden",
  // no status), its mirror, and a dropped-but-silent invalid pick all grade as FAIL.
  const r4Drop = gradeModel([{ t: 'ack', of: 'start', effective: { provider: 'openai', model: null }, overridden: ['model'] }], 'openai', 'gpt-5-codex');
  const r4Mirror = gradeModel([{ t: 'ack', of: 'start', effective: { provider: 'anthropic', model: null }, overridden: ['model'] }], 'anthropic', 'claude-opus-4-1');
  const r4Silent = gradeModel([{ t: 'ack', of: 'start', effective: { provider: 'openai', model: null }, overridden: ['model'] }], 'openai', null, { dropped: 'claude-opus-4-1' });
  check('MUST-FAIL (l, synthesized): the grader FAILS the round-4 silent drop, its mirror, and an invalid pick dropped without a word',
    !r4Drop.ok && !r4Mirror.ok && !r4Silent.ok, { r4Drop: r4Drop.ok, r4Mirror: r4Mirror.ok, r4Silent: r4Silent.ok });

  const writeOai3 = (id) => {
    fs.writeFileSync(orchardFileOf(id), [
      { type: 'user', message: { role: 'user', content: 'tighten the lexer' }, sessionId: id, cwd: PROJ3, timestamp: now, provider: 'openai' },
      { type: 'assistant', message: { role: 'assistant', model: 'gpt-5-codex', content: [{ type: 'text', text: 'Done.' }] }, sessionId: id, cwd: PROJ3, timestamp: now, provider: 'openai' },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  };
  const writeClaude4 = (id) => {
    fs.writeFileSync(path.join(STORE, enc4, `${id}.jsonl`), [
      { type: 'user', message: { role: 'user', content: 'hello claude' }, sessionId: id, cwd: PROJ4, timestamp: now, version: '2.1.0', uuid: randomUUID() },
      { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4', content: [{ type: 'text', text: 'Hi.' }] }, sessionId: id, cwd: PROJ4, timestamp: now, uuid: randomUUID() },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  };
  // (l1) OpenAI-pinned thread under the CLAUDE-default project, the fixed UI's own
  // resume frame {model} — the engine must RECEIVE the pick (ASSERT_MODEL).
  const L1 = randomUUID(); writeOai3(L1);
  // The fake exits 1 (a fatal frame) the moment turn/start lacks the model; its
  // resumed-thread notifications never complete a turn here, so collect for a fixed
  // window and prove the turn REACHED the engine from the fake's own input log.
  const inputLog = path.join(DATA, 'codex-input.log');
  const promptL1 = `ASSERT_MODEL:gpt-5-codex; continue ${L1}`;
  const l1 = await runStart({ type: 'start', projectId: P3.id, resumeSessionId: L1, resumeEncodedDir: enc3, prompt: promptL1, overrides: { model: 'gpt-5-codex' } },
    { expectResume: L1, stop: untilTurnEnd, ms: 12000 });
  const reachedL1 = (() => { try { return fs.readFileSync(inputLog, 'utf8').includes(promptL1); } catch { return false; } })();
  const gL1 = gradeModel(l1, 'openai', 'gpt-5-codex');
  check('(l1) OpenAI-pinned session under a Claude-default project keeps the user\'s gpt-5-codex pick, and the Codex engine receives it',
    gL1.ok && reachedL1, { ...gL1.detail, turnReachedEngine: reachedL1 });
  // (l2) same, with a stale provider on the frame too (the round-4 verifier's model-1).
  const L2 = randomUUID(); writeOai3(L2);
  const l2 = await runStart({ type: 'start', projectId: P3.id, resumeSessionId: L2, resumeEncodedDir: enc3, prompt: 'continue', overrides: { provider: 'anthropic', model: 'gpt-5-codex' } },
    { expectResume: L2, stop: untilInit });
  const gL2 = gradeModel(l2, 'openai', 'gpt-5-codex');
  check('(l2) a stale provider on the frame is ignored AND the model pick still survives onto the OpenAI run', gL2.ok, gL2.detail);
  // (l3) MIRROR: Claude-pinned session under the OPENAI-default project with a Claude pick.
  const L3 = randomUUID(); writeClaude4(L3);
  const l3 = await runStart({ type: 'start', projectId: P4.id, resumeSessionId: L3, resumeEncodedDir: enc4, prompt: 'continue', overrides: { provider: 'openai', model: 'claude-opus-4-1' } },
    { stop: untilAck });
  const gL3 = gradeModel(l3, 'anthropic', 'claude-opus-4-1');
  check('(l3) MIRROR: Claude-pinned session under an OpenAI-default project keeps the user\'s claude-opus-4-1 pick', gL3.ok, gL3.detail);
  // (l4) an INVALID pick for the pinned engine falls back VISIBLY, both directions.
  const L4 = randomUUID(); writeOai3(L4);
  const l4 = await runStart({ type: 'start', projectId: P3.id, resumeSessionId: L4, resumeEncodedDir: enc3, prompt: 'continue', overrides: { model: 'claude-opus-4-1' } },
    { expectResume: L4, stop: untilInit });
  const gL4 = gradeModel(l4, 'openai', null, { dropped: 'claude-opus-4-1' });
  check('(l4) a Claude model pick on an OpenAI-pinned session falls back to the engine default WITH a status (not silently), not listed as overridden',
    gL4.ok, gL4.detail);
  const L5 = randomUUID(); writeClaude4(L5);
  const l5 = await runStart({ type: 'start', projectId: P4.id, resumeSessionId: L5, resumeEncodedDir: enc4, prompt: 'continue', overrides: { model: 'gpt-5-codex' } },
    { stop: untilAck });
  const gL5 = gradeModel(l5, 'anthropic', null, { dropped: 'gpt-5-codex' });
  check('(l5) MIRROR: an OpenAI model pick on a Claude-pinned session falls back WITH a status, not silently',
    gL5.ok, gL5.detail);
  // (l6) CONTROL: no pick at all — the pinned engine's own default applies (no status noise).
  const L6 = randomUUID(); writeOai3(L6);
  const l6 = await runStart({ type: 'start', projectId: P3.id, resumeSessionId: L6, resumeEncodedDir: enc3, prompt: 'continue' },
    { expectResume: L6, stop: untilInit });
  const ack6 = l6.find((e) => e.t === 'ack' && e.of === 'start');
  check('(l6) CONTROL: no pick → the OpenAI-pinned run uses the engine default (the Claude project default model never leaks in), no model status',
    ack6?.effective?.provider === 'openai' && (ack6?.effective?.model ?? null) === null
      && !l6.some((e) => e.t === 'status' && /ignored your model pick/.test(String(e.status))),
    { ackProvider: ack6?.effective?.provider ?? null, ackModel: ack6?.effective?.model ?? null });

  // ============================================================================
  // BUG-196 round 5 — (m) THE SETTINGS DRAWER'S SESSION-SCOPE PROVIDER CONTROL goes
  // through the ONE guarded writer. Round 4 guarded pickProvider only; the drawer
  // wrote ctx.overrides.provider itself and accepted a switch for an existing id in
  // the pre-pin window and after a failed transcript fetch. Real headless Brave, the
  // real drawer DOM, real clicks.
  // ============================================================================
  const drawerTry = () => page.evaluate(async () => {
    const s = window.__station;
    await s.drawer.open('settings', { scope: 'session', focus: 'provider' });
    await new Promise((r) => setTimeout(r, 250));
    const btns = () => [...document.querySelectorAll('[data-focus="provider"] .prov-seg button[data-prov]')];
    const before = btns().map((b) => ({ k: b.dataset.prov, pressed: b.getAttribute('aria-pressed'), disabled: b.disabled }));
    const target = btns().find((b) => b.getAttribute('aria-pressed') !== 'true'); // the OTHER engine — a real switch
    let clicked = null;
    if (target && !target.disabled) { clicked = target.dataset.prov; target.click(); await new Promise((r) => setTimeout(r, 150)); }
    const warn = [...document.querySelectorAll('[data-focus="provider"] [data-warn="true"]')].map((n) => (n.textContent || '').slice(0, 100));
    return { sessionId: s.state.current.sessionId, pinned: s.lockedProviderOf(s.state.current.sessionId),
      before, clicked, memProvider: s.state.overrides.provider ?? null, view: s.providerView(), warn,
      refusal: typeof s.providerSwitchRefusal === 'function' ? s.providerSwitchRefusal() : null };
  });
  const closeDrawer = () => page.keyboard.press('Escape').catch(() => {});
  /** Grader: nothing was armed, every provider button was disabled, and the refusal was shown. */
  const gradeDrawerRefused = (d) => d.memProvider === null && d.clicked === null
    && d.before.length === 2 && d.before.every((b) => b.disabled)
    && d.warn.some((w) => /set by its transcript|runs on (OpenAI Codex|Claude)/.test(w));
  // Synthesized must-FAIL: the round-4 observation (an enabled button, clicked, armed).
  check('MUST-FAIL (m, synthesized): the grader FAILS the round-4 drawer observation (enabled, clicked, provider armed)',
    !gradeDrawerRefused({ memProvider: 'anthropic', clicked: 'anthropic', before: [{ disabled: false }, { disabled: false }], warn: [] }), 'constructed');

  // (m1) PRE-PIN window: an existing OpenAI thread under the Claude-default project,
  // transcript fetch HELD.
  const M1 = randomUUID(); writeOai3(M1);
  let releaseM; const heldM = new Promise((r) => { releaseM = r; });
  await page.route((url) => url.pathname.startsWith('/api/transcript/') && url.pathname.includes(M1), async (route) => {
    await heldM; try { await route.continue(); } catch { /* page moved on */ }
  });
  await page.evaluate((args) => {
    const s = window.__station;
    void s.openSession(s.state.projects.find((x) => x.id === args.pid), { encodedDir: args.enc, sessionId: args.id, displayTitle: 'tighten the lexer', os: 'linux' });
  }, { pid: P3.id, enc: enc3, id: M1 });
  await page.waitForFunction((id) => window.__station.state.current.sessionId === id, M1, { timeout: 15000 });
  const m1 = await drawerTry();
  check('(m1) pre-pin (transcript fetch held): the drawer session-scope provider control is disabled, refuses the switch, and says why',
    m1.pinned === null && gradeDrawerRefused(m1), m1);
  const m1Persist = await page.evaluate((key) => { try { return JSON.parse(localStorage.getItem('cs-overrides') ?? '{}')[key] ?? null; } catch { return 'UNPARSEABLE'; } }, `${enc3} ${M1}`);
  check('(m1) pre-pin: nothing is persisted for the session', !persistedProvider(m1Persist), m1Persist);
  await closeDrawer();
  releaseM();
  await page.waitForFunction((id) => window.__station.lockedProviderOf(id) === 'openai', M1, { timeout: 15000 }).catch(() => {});
  const m1b = await drawerTry();
  check('(m1) after the pin lands: still disabled, shows openai, the lock explanation replaces the refusal',
    m1b.pinned === 'openai' && gradeDrawerRefused(m1b) && m1b.before.find((b) => b.pressed === 'true')?.k === 'openai' && /runs on OpenAI Codex/.test(m1b.warn.join(' ')), m1b);
  await closeDrawer();
  await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
  // (m2) FAILED transcript fetch (HTTP 500): the pin never lands for this open.
  const M2 = randomUUID(); writeOai3(M2);
  await page.route((url) => url.pathname.startsWith('/api/transcript/') && url.pathname.includes(M2),
    (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' }));
  await page.evaluate((args) => {
    const s = window.__station;
    void s.openSession(s.state.projects.find((x) => x.id === args.pid), { encodedDir: args.enc, sessionId: args.id, displayTitle: 'tighten the lexer', os: 'linux' });
  }, { pid: P3.id, enc: enc3, id: M2 });
  await page.waitForFunction((id) => window.__station.state.current.sessionId === id, M2, { timeout: 15000 });
  await sleep(800);
  const m2 = await drawerTry();
  check('(m2) failed transcript fetch: the drawer session-scope provider control is disabled and refuses the switch',
    m2.pinned === null && gradeDrawerRefused(m2), m2);
  const m2Pick = await page.evaluate(() => { const s = window.__station; const r = s.pickProvider('openai'); return { r, mem: s.state.overrides.provider ?? null }; });
  check('(m2) failed transcript fetch: the one writer (pickProvider) refuses too — nothing armed', m2Pick.r === false && m2Pick.mem === null, m2Pick);
  await closeDrawer();
  await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
  // (m3) CONTROL: a genuinely new session (no id) — the drawer DOES arm, through the
  // same writer, and picking the project default clears the override again.
  await page.evaluate((pid) => window.__station.startNew(pid), P3.id);
  await sleep(200);
  const m3 = await drawerTry();
  const m3back = await page.evaluate(async () => {
    const b = document.querySelector('[data-focus="provider"] .prov-seg button[data-prov="anthropic"]');
    if (b && !b.disabled) { b.click(); await new Promise((r) => setTimeout(r, 150)); }
    return { mem: window.__station.state.overrides.provider ?? null, view: window.__station.providerView() };
  });
  check('(m3) CONTROL: on a new session the drawer arms OpenAI via the one writer, and picking the project default (Claude) clears it',
    m3.sessionId == null && m3.refusal === null && m3.clicked === 'openai' && m3.memProvider === 'openai' && m3.view === 'openai'
      && m3back.mem === null && m3back.view === 'anthropic', { m3, m3back });
  await closeDrawer();
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.stack ?? err.message}`);
  process.exitCode = 1;
}).finally(async () => {
  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  process.exitCode = fail ? 1 : (process.exitCode ?? 0);
  try { await browser?.close(); } catch { /* closed */ }
  try { if (server?.pid) process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ }
  await sleep(300);
  // BUG-196 round 4 — the real starts spawn engine children; reap ONLY processes
  // whose environment names this run's own scratch data dir (never anyone else's).
  try {
    for (const pid of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
      let env = '';
      try { env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8'); } catch { continue; }
      if (env.split('\0').includes(`CLAUDE_STATION_DATA=${DATA}`) && Number(pid) !== process.pid) {
        try { process.kill(Number(pid), 'SIGKILL'); } catch { /* gone */ }
      }
    }
  } catch { /* no /proc */ }
  for (const d of [DATA, STORE, PROJ, PROJ2, PROJ3, PROJ4, CODEX_HOME, CLAUDE_CFG]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  setTimeout(() => process.exit(process.exitCode ?? 0), 300).unref();
});
