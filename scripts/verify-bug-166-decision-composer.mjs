/**
 * BUG-166 — an AskUserQuestion prompt must NOT lock the user out of sending a
 * fresh message, and must NOT be labelled as "Claude is working".
 *
 * THE DEFECT (verified in code): the composer-send decision (submit) and the
 * session-status label (computeSessState) were both re-derived from the single
 * `state.busy` signal, which cannot tell "the model is working" from "the model
 * is STOPPED, paused on an AskUserQuestion, waiting on the user". So with a
 * question pending:
 *   1. LOCKOUT — a fresh, unrelated message fell into the busy branch and was
 *      HELD in the client queue, waiting for a `turn-end` that only the user's
 *      OWN answer to the question could produce. The composer "would not let it
 *      through": the user was forced to answer first.
 *   2. MISLABEL — computeSessState returned 'thinking' → "Thinking… / Claude is
 *      working", while Claude was in fact waiting on the user.
 *
 * THE FIX (public/app.js, ARCH-010): the pending question is the OWNER of "the
 * model stopped, waiting on you" — `state.decisionsByRequest` holds exactly the
 * cards still awaiting the user, pruned the instant one settles. A single
 * declaration, `awaitingUserDecision()`, reads that map; BOTH the composer and
 * the label read it instead of re-deriving from `busy`. With a decision pending:
 *   - submit() routes the fresh message down the server send path (the BUG-159
 *     HELD-not-refused channel, marked user-initiated) rather than the silent
 *     client hold-queue — the send LANDS on the wire.
 *   - computeSessState() returns 'awaiting' → "Waiting on you".
 *
 * WHAT THIS DRIVES — the REAL client in a REAL headless browser against a REAL
 * server. A REAL AskUserQuestion card is rendered through the REAL renderQuestion
 * path (which is the owner-write to decisionsByRequest); then the REAL submit()
 * and REAL computeSessState() run against that busy-with-pending-question state.
 * Nothing about the busy/awaiting derivation is re-implemented in the test.
 *
 * MUST-FAIL BASELINE — NOT `git show HEAD` (committing the fix would make HEAD
 * the fixed state and this could never fail again — docs/CONVENTIONS.md). The
 * pre-fix client is CONSTRUCTED by neutering the ONE construction point the fix
 * rests on: awaitingUserDecision()'s body, forced to `return false`. That single
 * neuter reproduces BOTH symptoms at once (label → 'thinking', send → held),
 * which is the proof they share one cause. The hit count is asserted.
 *
 * SYNTHETIC-STATE NOTE (stated per docs/CONVENTIONS.md): no real model is run —
 * a session cannot be cheaply/deterministically steered into raising an
 * AskUserQuestion. Instead the busy-with-live-socket fixture is assembled in the
 * page (state.live + an OPEN mock socket + state.busy) and a REAL question card
 * is rendered. That is faithful for THIS bug: the lockout+mislabel are purely a
 * function of (busy && a pending decision card exists), and both are produced by
 * the real code under test — the model's own words never enter the derivation.
 *
 *   node scripts/verify-bug-166-decision-composer.mjs
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
const PORT = Number(process.env.VERIFY_BUG166_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-166-data-'));
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-166-store-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-166-chrome-'));
const BRAVE = process.env.VERIFY_ROUTING_BROWSER ?? 'brave';

let pass = 0, fail = 0;
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  ok ? pass++ : fail++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); this.on = new Map(); }
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
      } else if (m.method && c.on.has(m.method)) {
        c.on.get(m.method)(m.params);
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
      await sleep(120);
    }
    console.log(`        (timed out waiting for ${label} after ${timeoutMs}ms)`);
    return false;
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

let server = null, browser = null;
const cleanupDirs = [DATA, STORE, PROFILE];
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

/*
 * The MUST-FAIL baseline. The pre-fix client is CONSTRUCTED from the current one
 * by forcing awaitingUserDecision() to `return false` — the single derivation
 * both readers now consult. With it always false, computeSessState falls through
 * to 'thinking' and submit falls into the client hold-queue: exactly the pre-fix
 * behaviour, reproducing BOTH symptoms from ONE neuter. Hit count asserted.
 */
function preFixClient() {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const from = '  for (const card of state.decisionsByRequest.values()) if (!card.answered) return true;';
  const to = '  /* PRE-FIX-166: awaitingUserDecision neutered so both readers fall back to busy */';
  const hits = src.split(from).length - 1;
  if (hits !== 1) throw new Error(`pre-fix transform matched ${hits}x (expected 1) for: ${JSON.stringify(from)}`);
  return src.replace(from, to);
}

const encodeCwd = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

/**
 * Assemble the busy-with-pending-question fixture in the page and drive the REAL
 * submit() + computeSessState() against it. Returns the observable outcome.
 */
function scenarioExpr(projId, encDir, text) {
  return `(() => {
    const st = window.__station;
    st.state.decisionsByRequest.clear();
    st.state.queue.length = 0;
    st.state.current.projectId = ${JSON.stringify(projId)};
    st.state.current.sessionId = 'sess-166';
    st.state.current.encodedDir = ${JSON.stringify(encDir)};
    st.state.current.os = 'linux';
    st.state.viewing = 'main';
    st.state.live = true;
    st.state.followingLive = false;
    st.state.deliveryRelay = null;
    st.state.snap = null;               // no snapshot -> idleBehindBackground() false
    st.state.pendingSend = null;
    st.state.sessPhase = 'thinking';
    const sent = [];
    st.state.ws = { readyState: 1, send: (s) => sent.push(s) }; // an OPEN socket (isDriving() true)
    st.state.busy = true;               // the AskUserQuestion turn is in flight

    // A REAL pending AskUserQuestion card — this is the owner-write to
    // decisionsByRequest that the fix reads.
    st.renderQuestion(st.mainThread(), {
      toolUseId: 'tu-166',
      requestId: 'req-166',
      questions: [{ question: 'Ship it now?', header: '', multiSelect: false,
        options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] }],
    });

    const labelState = st.computeSessState();
    st.paintSessStatus();
    const labelText = document.querySelector('#sessStatusLbl').textContent;

    // The user types a FRESH, unrelated message (NOT an answer) and hits send.
    document.querySelector('#prompt').value = ${JSON.stringify(text)};
    const queueBefore = st.state.queue.length;
    st.submit();
    const queueAfter = st.state.queue.length;

    const sends = sent.map((s) => { try { return JSON.parse(s); } catch { return null; } })
      .filter((m) => m && m.type === 'send');

    return {
      awaiting: st.awaitingUserDecision(),
      cardCount: st.state.decisionsByRequest.size,
      labelState, labelText,
      queueBefore, queueAfter,
      sentPrompts: sends.map((m) => m.prompt),
      pendingSendText: st.state.pendingSend ? st.state.pendingSend.text : null,
      stillBusy: st.state.busy,
    };
  })()`;
}

/** Drive the SETTLED-then-working case through the REAL prune path: once a card
 * settles (here via settleDecisionFromResult — the model's tool-result) its owner
 * drops it from decisionsByRequest, so the label honestly returns to "working". */
function afterSettleExpr() {
  return `(() => {
    const st = window.__station;
    const card = st.state.decisionsByRequest.get('req-166');
    const ownedBefore = st.state.decisionsByRequest.size;
    // The REAL settle path (a tool-result with no prior ack): settleDecisionOwner
    // prunes the card from its owner map.
    st.settleDecisionFromResult(card, { isError: false, preview: '' });
    const labelState = st.computeSessState();
    st.paintSessStatus();
    return { ownedBefore, ownedAfter: st.state.decisionsByRequest.size,
             awaiting: st.awaitingUserDecision(), labelState,
             labelText: document.querySelector('#sessStatusLbl').textContent };
  })()`;
}

async function main() {
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-166-proj-'));
  cleanupDirs.push(projDir);
  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: projDir, name: 'bug166-fixture' }),
  })).json();
  if (!reg.project?.id) throw new Error(`register failed: ${JSON.stringify(reg)}`);
  const projId = reg.project.id;
  const encDir = encodeCwd(projDir);

  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 60 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

  let servePreFix = false;
  const preFix = preFixClient();
  check('the pre-fix client was constructed by neutering awaitingUserDecision() (baseline is a variant, not HEAD)',
    preFix.includes('PRE-FIX-166') && !preFix.includes('if (!card.answered) return true;'),
    `${preFix.length} bytes; the single derivation point neutered to return false`);
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/app.js*', requestStage: 'Request' }] });
  cdp.on.set('Fetch.requestPaused', (p) => {
    if (/\/app\.js/.test(p.request.url) && servePreFix) {
      void cdp.send('Fetch.fulfillRequest', {
        requestId: p.requestId, responseCode: 200,
        responseHeaders: [{ name: 'content-type', value: 'text/javascript' }, { name: 'cache-control', value: 'no-store' }],
        body: Buffer.from(preFix, 'utf8').toString('base64'),
      }).catch(() => {});
      return;
    }
    void cdp.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
  });

  await cdp.send('Page.navigate', { url: `${BASE}/` });
  await cdp.waitFor('boot', `window.__station !== undefined`);
  const N = 'A totally different question about deployment';

  /* ═══════════════ 1. POST-FIX — the real client ═══════════════ */
  console.log('\n=== 1. POST-FIX: a pending AskUserQuestion neither locks the composer nor reads as "working" ===');
  const r = await cdp.eval(scenarioExpr(projId, encDir, N));
  check('precondition: exactly one pending decision card is owned (decisionsByRequest)',
    r.cardCount === 1 && r.awaiting === true, JSON.stringify({ cardCount: r.cardCount, awaiting: r.awaiting }));
  check('MISLABEL FIXED: with a question pending the session label is "waiting on you", NOT working',
    r.labelState === 'awaiting' && /waiting on you/i.test(r.labelText),
    JSON.stringify({ labelState: r.labelState, labelText: r.labelText }));
  check('LOCKOUT FIXED: the fresh message is NOT silently held in the client queue',
    r.queueAfter === r.queueBefore,
    JSON.stringify({ queueBefore: r.queueBefore, queueAfter: r.queueAfter }));
  check('LOCKOUT FIXED: the send actually LANDS on the wire as the user\'s turn (type:"send")',
    r.sentPrompts.includes(N), JSON.stringify({ sentPrompts: r.sentPrompts }));
  check('the fresh message is tracked as an optimistic user bubble (state.pendingSend), not a queued row',
    r.pendingSendText === N, JSON.stringify({ pendingSendText: r.pendingSendText }));

  console.log('\n=== 1b. POST-FIX: once the question settles the owner prunes it and the label returns to "working" ===');
  const a = await cdp.eval(afterSettleExpr());
  check('settled → the card is pruned from its owner (decisionsByRequest), so "waiting on you" clears to "working"',
    a.ownedBefore === 1 && a.ownedAfter === 0 && a.awaiting === false && a.labelState === 'thinking',
    JSON.stringify(a));

  /* ═══════════════ 2. MUST-FAIL — the synthesized pre-fix client ═══════════════ */
  console.log('\n=== 2. MUST-FAIL: the pre-fix client reproduces BOTH symptoms (lockout + mislabel) ===');
  servePreFix = true;
  await cdp.send('Page.navigate', { url: `${BASE}/?prefix=1` });
  await cdp.waitFor('pre-fix boot', `window.__station && typeof window.__station.awaitingUserDecision === 'function'`);
  const neutered = await cdp.eval(`(() => { const st = window.__station;
    st.state.decisionsByRequest.set('x', { answered: false, requestId: 'x' });
    return st.awaitingUserDecision(); })()`);
  check('the served client IS the neutered pre-fix (awaitingUserDecision always false)',
    neutered === false, `awaitingUserDecision() with a pending card => ${neutered}`);
  const rp = await cdp.eval(scenarioExpr(projId, encDir, N));
  check('MUST-FAIL (mislabel present): the pre-fix label reads "working", not "waiting on you"',
    rp.labelState === 'thinking' && /thinking/i.test(rp.labelText),
    JSON.stringify({ labelState: rp.labelState, labelText: rp.labelText }));
  check('MUST-FAIL (lockout present): the pre-fix client HOLDS the fresh message in the queue',
    rp.queueAfter === rp.queueBefore + 1 && rp.sentPrompts.length === 0,
    JSON.stringify({ queueBefore: rp.queueBefore, queueAfter: rp.queueAfter, sentPrompts: rp.sentPrompts }));

  cdp.close();
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
}

main()
  .catch((e) => { console.error(e); fail++; })
  .finally(() => {
    stopByPid(browser); stopByPid(server);
    for (const d of cleanupDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
    process.exit(fail === 0 ? 0 : 1);
  });
