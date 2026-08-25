/**
 * BUG-031 — provider/API errors must reach the user honestly (attributed,
 * non-generic, composer always resolves), for EVERY enumerated error class.
 *
 * Three layers, all against real code (WORKING_AGREEMENT §C, non-vacuous):
 *
 *  A. RUNTIME MAPPING (the real ClaudeRuntime.classifyProviderError, fixture
 *     frames byte-shaped from a live CLI probe + sdk.d.ts): every enumerated
 *     native failure shape → the provider-agnostic taxonomy; non-errors → null.
 *     Pre-fix: classifyProviderError does not exist — every check FAILS.
 *
 *  B. END-TO-END THROUGH THE REAL BRIDGE — no mocks anywhere: a REAL `claude`
 *     CLI session started with a nonexistent model. The real API answers 404,
 *     the real CLI emits the synthetic api-error assistant frame + result, the
 *     real bridge classifies + relays, the real UI must render the attributed
 *     card AND resolve busy. Costs $0 (the request never reaches a model).
 *     Also proves the Retry affordance end-to-end: clicking Retry re-sends the
 *     same prompt into the same session (which fails again, again for $0).
 *     Pre-fix: no .provider-error card ever exists; the status detail
 *     literally said "success · Ns" — both assertions FAIL.
 *
 *  C. UI RENDER for classes that cannot be induced on demand (529 overloaded,
 *     api_retry in progress, subscription quota-window, auth expiry) —
 *     injected as `provider-error` StationEvents through the real client
 *     event contract (window.__station.onEvent), the same seam the FEAT-042 /
 *     BUG-021 verifies used. Pre-fix: 'provider-error' hits onEvent's default
 *     case and renders NOTHING — every check FAILS.
 *
 *  D. LIVE SANITY — one real cheap haiku turn still works end-to-end and
 *     renders no provider-error card.
 *
 *   node scripts/verify-provider-errors.mjs
 *
 * Never touches :4317; spawns its own server on a free port; kills by pid.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const PORT = Number(process.env.VERIFY_PROVERR_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pe-data-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pe-chrome-'));
const BRAVE = process.env.VERIFY_ROUTING_BROWSER ?? 'brave';
const SHOT = path.join(ROOT, 'docs', 'bugs', 'assets');

let pass = 0, fail = 0;
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  ok ? pass++ : fail++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ===================== A. runtime mapping (real classifier) ===================== */

async function partA() {
  console.log('\n=== A. ClaudeRuntime.classifyProviderError — native shapes → agnostic taxonomy ===');
  let ClaudeRuntime;
  try {
    ({ ClaudeRuntime } = await import(path.join(ROOT, 'src', 'server', 'runtime', 'claude-runtime.ts')));
  } catch (err) {
    check('claude-runtime.ts imports', false, err.message);
    return;
  }
  const rt = new ClaudeRuntime();
  if (typeof rt.classifyProviderError !== 'function') {
    check('ClaudeRuntime implements classifyProviderError', false, 'method missing (pre-fix state)');
    return;
  }
  const c = (m) => rt.classifyProviderError(m);

  // 1) 529 overloaded — the user's concrete case. Frame shape is the probed
  //    synthetic-assistant carrier (live CLI 2.1.222) with the overloaded text.
  const t529 = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":null} · Please try again later or check status.claude.com';
  const e529 = c({
    type: 'assistant', parent_tool_use_id: null, session_id: 's', uuid: 'u',
    error: 'overloaded', is_api_error_message: true, request_id: 'req_x',
    message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: t529 }] },
  });
  check('529 → kind overloaded, retryable, provider anthropic, detail verbatim, statusUrl',
    e529?.kind === 'overloaded' && e529?.retryable === true && e529?.provider === 'anthropic'
      && e529?.detail === t529 && /status\.claude\.com/.test(String(e529?.statusUrl)), e529);

  // 2) model_not_found — byte-shaped from the live probe.
  const tMnf = "There's an issue with the selected model (totally-bogus-model-xyz). It may not exist or you may not have access to it.";
  const eMnf = c({
    type: 'assistant', parent_tool_use_id: null, session_id: 's', uuid: 'u',
    error: 'model_not_found', is_api_error_message: true,
    message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: tMnf }] },
  });
  check('model_not_found → model-unavailable, not retryable, detail verbatim',
    eMnf?.kind === 'model-unavailable' && eMnf?.retryable === false && eMnf?.detail === tMnf, eMnf);

  // 3) auth expiry (terminal assistant carrier).
  const eAuth = c({
    type: 'assistant', error: 'authentication_failed', is_api_error_message: true,
    message: { model: '<synthetic>', content: [{ type: 'text', text: 'OAuth token has expired.' }] },
  });
  check('authentication_failed → auth-expired, not retryable',
    eAuth?.kind === 'auth-expired' && eAuth?.retryable === false && /expired/i.test(eAuth?.detail), eAuth);

  // 4) rate_limit terminal → rate-limited; billing_error → quota-window.
  const eRl = c({ type: 'assistant', error: 'rate_limit', is_api_error_message: true, message: { content: [{ type: 'text', text: 'API Error: 429 rate limited' }] } });
  const eBill = c({ type: 'assistant', error: 'billing_error', is_api_error_message: true, message: { content: [{ type: 'text', text: 'Credit balance too low' }] } });
  check('rate_limit → rate-limited (retryable); billing_error → quota-window',
    eRl?.kind === 'rate-limited' && eRl?.retryable === true && eBill?.kind === 'quota-window', { eRl, eBill });

  // 5) system/api_retry — engine retrying, turn alive (SDKAPIRetryMessage).
  const eRetry = c({ type: 'system', subtype: 'api_retry', attempt: 3, max_retries: 10, retry_delay_ms: 8000, error_status: 529, error: 'overloaded', uuid: 'u', session_id: 's' });
  check('api_retry (HTTP 529) → overloaded with retrying{attempt 3/10, 8000ms}, statusCode 529',
    eRetry?.kind === 'overloaded' && eRetry?.retrying?.attempt === 3 && eRetry?.retrying?.maxRetries === 10
      && eRetry?.retrying?.delayMs === 8000 && eRetry?.statusCode === 529, eRetry);

  // 6) api_retry with error_status null = connection error → network.
  const eNet = c({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: null, error: 'unknown' });
  check('api_retry (no HTTP response) → network', eNet?.kind === 'network' && eNet?.statusCode === null, eNet);

  // 7) auth_status channel error → auth-expired.
  const eAs = c({ type: 'auth_status', isAuthenticating: false, output: [], error: 'Authentication failed: token revoked' });
  check('auth_status.error → auth-expired', eAs?.kind === 'auth-expired' && /revoked/.test(eAs?.detail), eAs);

  // 8) subscription window exhausted (SDKRateLimitEvent rejected) → quota-window.
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  const eQw = c({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', utilization: 100, resetsAt } });
  check('rate_limit_event rejected(five_hour) → quota-window with resetsAt',
    eQw?.kind === 'quota-window' && eQw?.retryable === false && eQw?.resetsAt === resetsAt && /five_hour/.test(eQw?.detail), eQw);

  // 9) SDKResultError with errors[] → internal, detail carried (was dropped pre-fix).
  const eRes = c({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['tool crashed: ENOENT', 'cleanup failed'] });
  check('result error_during_execution + errors[] → internal with joined detail',
    eRes?.kind === 'internal' && eRes?.detail === 'tool crashed: ENOENT; cleanup failed', eRes);

  // 10) NON-vacuity: non-error frames classify null.
  const nulls = [
    c({ type: 'assistant', message: { model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'hello' }] }, parent_tool_use_id: null }),
    c({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }),
    c({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', utilization: 12 } }),
    c({ type: 'system', subtype: 'init' }),
    c({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [] }), // interrupt shape: no detail → stays silent
  ];
  check('non-error frames (plain text, clean result, allowed rate-limit, init, empty-errors interrupt) → null',
    nulls.every((x) => x === null), nulls);
}

/* ============================ browser plumbing ============================ */

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const c = new Cdp(ws);
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.id && c.waiting.has(m.id)) {
        const { res, rej } = c.waiting.get(m.id);
        c.waiting.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    });
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.waiting.set(id, { res, rej }));
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value;
  }
  async waitFor(label, expr, timeoutMs = 30_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { if (await this.eval(expr)) return true; } catch { /* nav */ }
      await sleep(150);
    }
    console.log(`        (timed out waiting for ${label} after ${timeoutMs}ms)`);
    return false;
  }
  async shot(file) {
    try {
      const r = await this.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(SHOT, file), Buffer.from(r.data, 'base64'));
      console.log(`        (screenshot ${file})`);
    } catch { /* best effort */ }
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

let server = null, browser = null;
const cleanupDirs = [DATA, PROFILE];
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

async function main() {
  await partA();

  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pe-proj-'));
  cleanupDirs.push(projDir);
  cleanupDirs.push(path.join(os.homedir(), '.claude', 'projects', projDir.replace(/[^a-zA-Z0-9]/g, '-')));
  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: projDir, name: 'provider-error-fixture' }),
  })).json();
  if (!reg.project?.id) throw new Error(`register failed: ${JSON.stringify(reg)}`);
  await fetch(`${BASE}/api/projects/${reg.project.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ permissionMode: 'bypassPermissions' }),
  });

  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 60 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: `${BASE}/#/project/${reg.project.id}` });
  await cdp.waitFor('boot', `window.__station !== undefined`);
  await cdp.waitFor('project routed', `window.__station.state.current.projectId === ${JSON.stringify(reg.project.id)}`);

  /* ============ B. real CLI + real bridge: nonexistent model ($0) ============ */
  console.log('\n=== B. end-to-end through the REAL bridge: a real CLI turn on a nonexistent model ===');
  await cdp.eval(`(() => {
    window.__station.state.overrides.model = 'totally-bogus-model-bug031';
    document.querySelector('#prompt').value = 'Say hi.';
    document.querySelector('#go').click();
  })()`);
  const gotCard = await cdp.waitFor('provider-error card', `document.querySelector('.provider-error') !== null`, 60_000);
  const cardB = await cdp.eval(`(() => {
    const c = document.querySelector('.provider-error');
    return c ? { kind: c.dataset.kind, provider: c.dataset.provider,
      head: c.querySelector('.pe-head')?.textContent,
      detail: c.querySelector('.pe-detail')?.textContent,
      retryBtn: !!c.querySelector('.pe-retry') } : null;
  })()`);
  check('the REAL api-error turn renders an ATTRIBUTED provider-error card (kind=model-unavailable, provider=anthropic, provider\'s own text)',
    gotCard && cardB?.kind === 'model-unavailable' && cardB?.provider === 'anthropic'
      && /issue with the selected model/i.test(String(cardB?.detail)), cardB);

  const idleB = await cdp.waitFor('busy resolves', `window.__station.state.busy === false`, 30_000);
  check('the composer/busy state RESOLVES after the provider error (no stuck session)', idleB,
    await cdp.eval(`({ busy: window.__station.state.busy })`));

  const statusB = await cdp.eval(`({
    sessState: window.__station.computeSessState(),
    sessError: window.__station.state.sessError,
    fine: document.querySelector('#fine')?.textContent,
  })`);
  check('session status is an ATTRIBUTED error — and never labels the api-error turn "success"',
    statusB.sessState === 'error' && /anthropic/.test(String(statusB.sessError))
      && !/^success/.test(String(statusB.fine)) && !/success/.test(String(statusB.sessError)), statusB);

  const dupB = await cdp.eval(`[...document.querySelectorAll('#panes .claude .body > :not(.provider-error):not(.pe-foot)')]
    .filter((n) => /issue with the selected model/i.test(n.textContent)).length`);
  check('the provider\'s error text is NOT ALSO rendered as ordinary assistant speech (no duplicate, no fake "Claude said")',
    dupB === 0, `${dupB} duplicate node(s)`);
  await cdp.shot('BUG-031-model-unavailable-live.png');

  // Retry affordance is honest for a non-retryable kind: no button.
  check('a non-retryable error (model-unavailable) offers NO Retry button', cardB?.retryBtn === false, cardB);

  /* ============ C. classes not induceable on demand — real client event seam ============ */
  console.log('\n=== C. injected StationEvents (the FEAT-042/BUG-021 seam): 529 / retrying / quota / auth ===');

  // 529 overloaded, terminal — the user's concrete question.
  await cdp.eval(`(() => {
    window.__station.state.busy = true; // as it would be mid-turn
    window.__station.onEvent({ t: 'provider-error', kind: 'overloaded', retryable: true,
      provider: 'anthropic',
      detail: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}} · Please try again later or check status.claude.com',
      statusUrl: 'https://status.claude.com' });
    window.__station.onEvent({ t: 'turn-end', subtype: 'success', interrupted: false, isError: true,
      durationMs: 1200, terminalReason: 'api_error' });
  })()`);
  const c529 = await cdp.eval(`(() => {
    const cards = [...document.querySelectorAll('.provider-error')];
    const c = cards[cards.length - 1];
    return { n: cards.length, kind: c?.dataset.kind,
      head: c?.querySelector('.pe-head')?.textContent,
      detail: c?.querySelector('.pe-detail')?.textContent,
      statusLink: c?.querySelector('.pe-status')?.getAttribute('href'),
      retryBtn: !!c?.querySelector('.pe-retry'),
      busy: window.__station.state.busy,
      sessError: window.__station.state.sessError,
      fine: document.querySelector('#fine')?.textContent };
  })()`);
  check('529 Overloaded renders attributed (anthropic — servers overloaded), detail verbatim, status.claude.com linked, Retry offered',
    c529.kind === 'overloaded' && /anthropic/.test(String(c529.head)) && /overloaded/i.test(String(c529.head))
      && /API Error: 529/.test(String(c529.detail)) && c529.statusLink === 'https://status.claude.com'
      && c529.retryBtn === true, c529);
  check('after the 529 turn-end: busy resolved, status line attributed — NOT the SDK\'s literal "success"',
    c529.busy === false && /anthropic/.test(String(c529.sessError)) && !/success/.test(String(c529.sessError))
      && !/^success/.test(String(c529.fine)), { busy: c529.busy, sessError: c529.sessError, fine: c529.fine });
  await cdp.shot('BUG-031-529-overloaded.png');

  // Engine-retrying shape: ticker speaks, busy stays true, NO card spam.
  const cardsBefore = await cdp.eval(`document.querySelectorAll('.provider-error').length`);
  await cdp.eval(`(() => {
    window.__station.state.busy = true;
    window.__station.onEvent({ t: 'provider-error', kind: 'overloaded', retryable: true,
      provider: 'anthropic', detail: 'API request failed (HTTP 529, overloaded) — the engine is retrying',
      statusCode: 529, statusUrl: 'https://status.claude.com',
      retrying: { attempt: 4, maxRetries: 10, delayMs: 8000 } });
  })()`);
  const cRetry = await cdp.eval(`({
    fine: document.querySelector('#fine')?.textContent,
    busy: window.__station.state.busy,
    cards: document.querySelectorAll('.provider-error').length })`);
  check('a retrying 529 shows "retry 4/10" in the ticker, keeps busy TRUE (turn is alive), adds no card',
    /retry 4\/10/.test(String(cRetry.fine)) && /529/.test(String(cRetry.fine))
      && cRetry.busy === true && cRetry.cards === cardsBefore, cRetry);
  await cdp.eval(`window.__station.state.busy = false; void 0`);

  // Subscription quota-window (Claude 5h bucket — the class Codex expresses as its rolling 5h window).
  await cdp.eval(`(() => {
    window.__station.onEvent({ t: 'provider-error', kind: 'quota-window', retryable: false,
      provider: 'anthropic', detail: 'subscription usage limit reached (five_hour)',
      resetsAt: Math.floor(Date.now() / 1000) + 3600 });
  })()`);
  const cQw = await cdp.eval(`(() => {
    const cards = [...document.querySelectorAll('.provider-error')];
    const c = cards[cards.length - 1];
    return { kind: c?.dataset.kind, head: c?.querySelector('.pe-head')?.textContent,
      reset: c?.querySelector('.pe-reset')?.textContent, retryBtn: !!c?.querySelector('.pe-retry') };
  })()`);
  check('quota-window renders "usage limit reached" with the reset time, no Retry (retrying cannot help)',
    cQw.kind === 'quota-window' && /usage limit/i.test(String(cQw.head))
      && /resets /.test(String(cQw.reset)) && cQw.retryBtn === false, cQw);

  // Auth expiry.
  await cdp.eval(`window.__station.onEvent({ t: 'provider-error', kind: 'auth-expired', retryable: false,
    provider: 'anthropic', detail: 'OAuth token has expired. Run /login.' }); void 0`);
  const cAuth = await cdp.eval(`(() => {
    const cards = [...document.querySelectorAll('.provider-error')];
    const c = cards[cards.length - 1];
    return { kind: c?.dataset.kind, head: c?.querySelector('.pe-head')?.textContent, detail: c?.querySelector('.pe-detail')?.textContent };
  })()`);
  check('auth-expired renders attributed with the provider\'s own instruction text',
    cAuth.kind === 'auth-expired' && /authentication expired/i.test(String(cAuth.head)) && /OAuth token/.test(String(cAuth.detail)), cAuth);

  /* ============ B2. the Retry affordance actually re-sends (real path, $0) ============ */
  console.log('\n=== B2. Retry re-sends the failed prompt through the real session ===');
  const cardsPreRetry = await cdp.eval(`document.querySelectorAll('.provider-error[data-kind="model-unavailable"]').length`);
  await cdp.eval(`(() => {
    // the REAL card from part B (first one) — its session still runs the bogus model
    document.querySelector('.provider-error .pe-retry')?.click(); // 529 card's button (retryable)
  })()`);
  // The 529 card's Retry re-submits lastTurnPrompt ('Say hi.') into the live
  // bogus-model session → the REAL pipeline fails again → a SECOND real
  // model-unavailable card. Proves the affordance drives the actual send path.
  const retried = await cdp.waitFor('second real api-error card',
    `document.querySelectorAll('.provider-error[data-kind="model-unavailable"]').length > ${cardsPreRetry}`, 60_000);
  check('clicking Retry re-sends the failed prompt through the REAL session (a second real api-error round-trip observed)',
    retried, await cdp.eval(`({
      mnfCards: document.querySelectorAll('.provider-error[data-kind="model-unavailable"]').length,
      busy: window.__station.state.busy })`));
  await cdp.waitFor('busy resolves again', `window.__station.state.busy === false`, 30_000);

  /* ============ D. live sanity: a healthy cheap turn still works ============ */
  console.log('\n=== D. live sanity — a real haiku turn is unaffected ===');
  const projDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pe-proj2-'));
  cleanupDirs.push(projDir2);
  cleanupDirs.push(path.join(os.homedir(), '.claude', 'projects', projDir2.replace(/[^a-zA-Z0-9]/g, '-')));
  const reg2 = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: projDir2, name: 'provider-error-sanity' }),
  })).json();
  await fetch(`${BASE}/api/projects/${reg2.project.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'haiku', permissionMode: 'bypassPermissions', maxBudgetUsd: 0.25 }),
  });
  // Hash-only Page.navigate does NOT reload the SPA — force a real reload so
  // the page boots cleanly on the sanity project (no part-B/C cards linger).
  await cdp.eval(`(() => { location.href = ${JSON.stringify(`${BASE}/#/project/`)} + ${JSON.stringify(reg2.project.id)}; location.reload(); })()`).catch(() => { /* navigation kills the eval */ });
  await cdp.waitFor('boot 2', `window.__station !== undefined && window.__station.state.current.projectId === ${JSON.stringify(reg2.project.id)}`, 30_000);
  await cdp.eval(`(() => {
    document.querySelector('#prompt').value = 'Reply with exactly OK and nothing else.';
    document.querySelector('#go').click();
  })()`);
  const sane = await cdp.waitFor('healthy turn completes', `window.__station.state.busy === false && window.__station.state.sdkSessionId !== null`, 90_000);
  const saneObs = await cdp.eval(`({
    cards: document.querySelectorAll('.provider-error').length,
    sessState: window.__station.computeSessState(),
    gotText: [...document.querySelectorAll('#panes .claude .body p')].some((n) => /OK/.test(n.textContent)) })`);
  check('a healthy real haiku turn completes: no provider-error card, state idle, reply rendered',
    sane && saneObs.cards === 0 && saneObs.sessState === 'idle' && saneObs.gotText, saneObs);

  cdp.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}`);
  process.exitCode = 1;
}).finally(() => {
  stopByPid(browser);
  stopByPid(server);
  setTimeout(() => {
    for (const d of cleanupDirs) fs.rmSync(d, { recursive: true, force: true });
    process.exit(process.exitCode ?? 1);
  }, 2500);
});
