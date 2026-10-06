/**
 * BUG-150 INDEPENDENT ADVERSARIAL verify (verifier-authored, NOT the fixer's).
 * Attacks the fixer's fixture does NOT cover, driving REAL browser + REAL server
 * + REAL openSession/adoptQueueRows/persistQueue:
 *
 *   A. FULL RELOAD ROUND-TRIP — type during the load window, RELOAD the page,
 *      reopen the same session, and prove the message comes BACK on screen and
 *      is still stored. (The fixture stops at "it is in localStorage" and never
 *      reloads+reopens — the actual user durability guarantee.)
 *   B. RAPID SESSION SWITCH MID-LOAD — open A (pending on its fetch), queue a
 *      msg in A's window; open B while A still pending, queue a msg in B's
 *      window. Prove each msg is stored under ITS OWN key, neither leaks nor is
 *      lost; then reopen A and prove only A's msg returns (no cross-contam, no
 *      dup — success criterion #2).
 *   C. FAILED TRANSCRIPT FETCH (catch path) — queue in the window, force the
 *      transcript endpoint to 500 so openSession takes its catch branch; prove
 *      the windowed msg survives the catch and is not dropped/duplicated.
 *   D. WHITESPACE-ONLY window row — queue "   "; prove nothing durable is
 *      written for it and no phantom row is restored.
 *
 *   node scripts/verify-bug-150-adversarial.mjs
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
const PORT = Number(await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-150a-data-'));
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-150a-store-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-150a-chrome-'));
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
      } else if (m.method && c.on.has(m.method)) { c.on.get(m.method)(m.params); }
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
const encodeCwd = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

// Open a synthetic session WITHOUT awaiting, then queue in the SAME tick — lands
// in the load window. sess is provided so callers can pin sessionId (for reopen).
function openAndQueue(projId, encDir, sessId, needle, holderVar) {
  return `(() => {
    const st = window.__station;
    const p = st.state.projects.find((x) => x.id === ${JSON.stringify(projId)});
    const sess = { encodedDir: ${JSON.stringify(encDir)}, sessionId: ${JSON.stringify(sessId)}, os: 'linux', displayTitle: 'adv fixture' };
    window[${JSON.stringify(holderVar)}] = st.openSession(p, sess);
    st.queueMessage(${JSON.stringify(needle)});
    return {
      stored: localStorage.getItem(st.QUEUE_KEY),
      ownerKey: st.queueOwnerKey(),
      draftKey: st.draftKey(st.state.current),
      queueLen: st.state.queue.length,
    };
  })()`;
}
// Reopen (await it) and report what came back into state.queue + storage.
function reopenAndRead(projId, encDir, sessId) {
  return `(async () => {
    const st = window.__station;
    const p = st.state.projects.find((x) => x.id === ${JSON.stringify(projId)});
    const sess = { encodedDir: ${JSON.stringify(encDir)}, sessionId: ${JSON.stringify(sessId)}, os: 'linux', displayTitle: 'adv reopen' };
    await st.openSession(p, sess).catch(() => {});
    return {
      queueTexts: st.state.queue.map((q) => q.text),
      queueLen: st.state.queue.length,
      stored: localStorage.getItem(st.QUEUE_KEY),
      ownerKey: st.queueOwnerKey(),
    };
  })()`;
}

let transcriptMode = 'delay'; // 'delay' (200ms empty) | 'fail' (500)

async function main() {
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-150a-proj-'));
  cleanupDirs.push(projDir);
  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: projDir, name: 'bug150a-fixture' }),
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
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/transcript/*', requestStage: 'Request' }] });
  cdp.on.set('Fetch.requestPaused', (p) => {
    if (!/\/api\/transcript\//.test(p.request.url)) { void cdp.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {}); return; }
    if (transcriptMode === 'fail') {
      void cdp.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 500,
        responseHeaders: [{ name: 'content-type', value: 'application/json' }],
        body: Buffer.from(JSON.stringify({ error: 'boom' }), 'utf8').toString('base64') }).catch(() => {});
      return;
    }
    setTimeout(() => {
      void cdp.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200,
        responseHeaders: [{ name: 'content-type', value: 'application/json' }],
        body: Buffer.from(JSON.stringify({ messages: [], total: 0, offset: 0, tookMs: 0 }), 'utf8').toString('base64') }).catch(() => {});
    }, 400);
  });

  await cdp.send('Page.navigate', { url: `${BASE}/` });
  await cdp.waitFor('boot', `window.__station !== undefined`);

  /* ═══ A. FULL RELOAD ROUND-TRIP ═══ */
  console.log('\n=== A. reload round-trip: window msg must come BACK after a real reload+reopen ===');
  const SIDA = 'sess-A-' + Math.random().toString(36).slice(2);
  const NA = 'Reply with exactly: ROUNDTRIP-ALPHA';
  const a1 = await cdp.eval(openAndQueue(projId, encDir, SIDA, NA, '__openA'));
  check('A: window msg stored at once under this session', String(a1.stored ?? '').includes('ROUNDTRIP-ALPHA'), (a1.stored ?? '(none)').slice(0, 160));
  await cdp.eval(`window.__openA.catch(() => {})`);
  await sleep(150);
  // REAL reload — wipe heap, keep localStorage.
  await cdp.send('Page.reload', { ignoreCache: true });
  await cdp.waitFor('reboot', `window.__station !== undefined`);
  const survived = await cdp.eval(`localStorage.getItem(window.__station.QUEUE_KEY)`);
  check('A: after reload, storage still holds the msg (survived tab wipe)', String(survived ?? '').includes('ROUNDTRIP-ALPHA'), (survived ?? '(none)').slice(0, 160));
  const aRe = await cdp.eval(reopenAndRead(projId, encDir, SIDA));
  check('A: reopening the session RESTORES the msg onto the dock (user gets it back)',
    aRe.queueTexts.includes(NA), JSON.stringify(aRe.queueTexts));
  check('A: exactly one copy restored (no duplication on adopt)',
    aRe.queueTexts.filter((t) => t === NA).length === 1, JSON.stringify({ texts: aRe.queueTexts }));

  /* ═══ B. RAPID SESSION SWITCH MID-LOAD ═══ */
  console.log('\n=== B. two sessions switched mid-load: no loss, no leak, no dup ===');
  await cdp.eval(`localStorage.removeItem(window.__station.QUEUE_KEY)`);
  const SIDB1 = 'sess-B1-' + Math.random().toString(36).slice(2);
  const SIDB2 = 'sess-B2-' + Math.random().toString(36).slice(2);
  const NB1 = 'Reply with exactly: SWITCH-BRAVO-ONE';
  const NB2 = 'Reply with exactly: SWITCH-BRAVO-TWO';
  const b1 = await cdp.eval(openAndQueue(projId, encDir, SIDB1, NB1, '__openB1')); // A pending, queue B1
  const b2 = await cdp.eval(openAndQueue(projId, encDir, SIDB2, NB2, '__openB2')); // switch to B2 mid-load, queue B2
  check('B: B1 owner key differs from B2 owner key (distinct sessions)', b1.ownerKey && b2.ownerKey && b1.ownerKey !== b2.ownerKey, JSON.stringify({ b1: b1.ownerKey, b2: b2.ownerKey }));
  const bStore = await cdp.eval(`localStorage.getItem(window.__station.QUEUE_KEY)`);
  check('B: BOTH messages are durably stored (neither switch dropped one)',
    String(bStore).includes('SWITCH-BRAVO-ONE') && String(bStore).includes('SWITCH-BRAVO-TWO'), (bStore ?? '(none)').slice(0, 300));
  await cdp.eval(`Promise.allSettled([window.__openB1, window.__openB2])`);
  await sleep(200);
  const bReopenA = await cdp.eval(reopenAndRead(projId, encDir, SIDB1));
  check('B: reopening B1 restores ONLY B1 msg (no leak of B2 into B1)',
    bReopenA.queueTexts.includes(NB1) && !bReopenA.queueTexts.includes(NB2), JSON.stringify(bReopenA.queueTexts));
  const bReopenB = await cdp.eval(reopenAndRead(projId, encDir, SIDB2));
  check('B: reopening B2 restores ONLY B2 msg (no leak of B1 into B2)',
    bReopenB.queueTexts.includes(NB2) && !bReopenB.queueTexts.includes(NB1), JSON.stringify(bReopenB.queueTexts));

  /* ═══ C. FAILED TRANSCRIPT FETCH (catch path) ═══ */
  console.log('\n=== C. transcript fetch 500s: window msg survives the catch branch ===');
  await cdp.eval(`localStorage.removeItem(window.__station.QUEUE_KEY)`);
  transcriptMode = 'fail';
  const SIDC = 'sess-C-' + Math.random().toString(36).slice(2);
  const NC = 'Reply with exactly: CATCH-CHARLIE';
  const c1 = await cdp.eval(openAndQueue(projId, encDir, SIDC, NC, '__openC'));
  check('C: window msg stored even though the transcript fetch will fail', String(c1.stored ?? '').includes('CATCH-CHARLIE'), (c1.stored ?? '(none)').slice(0, 160));
  await cdp.eval(`window.__openC.catch(() => {})`);
  await sleep(300);
  const cAfter = await cdp.eval(`localStorage.getItem(window.__station.QUEUE_KEY)`);
  check('C: after the catch branch runs, the msg is STILL stored (not dropped by failure path)', String(cAfter ?? '').includes('CATCH-CHARLIE'), (cAfter ?? '(none)').slice(0, 160));
  transcriptMode = 'delay';
  const cRe = await cdp.eval(reopenAndRead(projId, encDir, SIDC));
  check('C: reopen restores exactly one copy of the msg', cRe.queueTexts.filter((t) => t === NC).length === 1, JSON.stringify(cRe.queueTexts));

  /* ═══ E. AFTER a failed fetch: ownership + a NEWLY-typed msg (the regression) ═══ */
  console.log('\n=== E. failed fetch drops ownership -> text typed AFTER is silently lost ===');
  await cdp.eval(`localStorage.removeItem(window.__station.QUEUE_KEY)`);
  transcriptMode = 'fail';
  const SIDE = 'sess-E-' + Math.random().toString(36).slice(2);
  const NE1 = 'Reply with exactly: FAIL-ECHO-DURING';
  await cdp.eval(openAndQueue(projId, encDir, SIDE, NE1, '__openE'));
  await cdp.eval(`window.__openE.catch(() => {})`);
  await sleep(300); // let the catch branch (resetTranscript + judgeAdoptedOutbox) run
  const eState = await cdp.eval(`(() => {
    const st = window.__station;
    return { ownerKey: st.queueOwnerKey(), draftKey: st.draftKey(st.state.current), queueLen: st.state.queue.length };
  })()`);
  check('E: after the failed fetch, ownership is STILL held for this session (queueOwnerKey === draftKey)',
    eState.ownerKey && eState.ownerKey === eState.draftKey, JSON.stringify(eState));
  check('E: the window msg is STILL visible in the dock after the failure (not wiped from state.queue)',
    eState.queueLen >= 1, JSON.stringify(eState));
  // Now the user types a NEW message after the failure — the exact BUG-150 class.
  const NE2 = 'Reply with exactly: FAIL-ECHO-AFTER';
  const eAfter = await cdp.eval(`(() => {
    const st = window.__station;
    st.queueMessage(${JSON.stringify(NE2)});
    return { stored: localStorage.getItem(st.QUEUE_KEY), ownerKey: st.queueOwnerKey() };
  })()`);
  check('E: SUCCESS CRITERION #1 on the failure path — a msg typed AFTER the failed fetch is durably stored',
    String(eAfter.stored ?? '').includes('FAIL-ECHO-AFTER'), (eAfter.stored ?? '(nothing stored)').slice(0, 200));

  /* ═══ D. WHITESPACE-ONLY window row ═══ */
  console.log('\n=== D. whitespace-only row: nothing durable, nothing phantom ===');
  await cdp.eval(`localStorage.removeItem(window.__station.QUEUE_KEY)`);
  const SIDD = 'sess-D-' + Math.random().toString(36).slice(2);
  const d1 = await cdp.eval(openAndQueue(projId, encDir, SIDD, '     ', '__openD'));
  const dStore = d1.stored ?? '';
  check('D: a whitespace-only row writes no persisted text row', !/"text":"\s+"/.test(dStore) && !dStore.includes('rows":[{"text'), (dStore || '(nothing stored)').slice(0, 160));
  await cdp.eval(`window.__openD.catch(() => {})`);

  /* ═══ ROUND-4: attack the new shape — re-binding lives INSIDE resetTranscript ═══ */
  transcriptMode = 'delay';
  const setCur = (obj) => `window.__station.state.current = ${JSON.stringify(obj)};`;
  // BUG-217 round 5: the tab's store now holds only requests the server has not acknowledged, one entry per
  // request (keyed by nonce, filed under the session key) — seed it in THAT shape. The properties below are unchanged.
  const putStore = (key, texts) => `(() => {
    const st = window.__station;
    const raw = JSON.parse(localStorage.getItem(st.QUEUE_KEY) ?? '{}');
    ${JSON.stringify(texts)}.forEach((t, i) => {
      const nonce = 'n-seed-' + Math.random().toString(36).slice(2) + '-' + i;
      raw[nonce] = { key: ${JSON.stringify(key)}, at: Date.now() + i, req: { nonce, text: t, origin: 'queued' } };
    });
    localStorage.setItem(st.QUEUE_KEY, JSON.stringify(raw));
  })();`;

  /* F. DOUBLE RESET — reset empties the queue before re-adopting, so twice must not duplicate. */
  console.log('\n=== F. double resetTranscript(): idempotent, no duplicate rows ===');
  const SIDF = 'sess-F-' + Math.random().toString(36).slice(2);
  const keyF = `s\x00${encDir}\x00${SIDF}`;
  const f = await cdp.eval(`(() => {
    const st = window.__station;
    localStorage.removeItem(st.QUEUE_KEY);
    ${putStore(keyF, ['DOUBLE-FOXTROT'])}
    ${setCur({ projectId: projId, encodedDir: encDir, sessionId: SIDF })}
    st.resetTranscript(); st.resetTranscript();
    return { texts: st.state.queue.map((q) => q.text), owner: st.queueOwnerKey(), want: st.draftKey(st.state.current) };
  })()`);
  check('F: after two resets, exactly one copy of the row (reset clears before re-adopting)',
    f.texts.filter((t) => t === 'DOUBLE-FOXTROT').length === 1, JSON.stringify(f));
  check('F: ownership bound to THIS session key', f.owner === f.want && !!f.owner, JSON.stringify(f));

  /* G. CROSS-KEY STRICTNESS — reset must restore ONLY draftKey(state.current)'s rows, never another key's. */
  console.log('\n=== G. reset restores only the current session, never another key (no contamination) ===');
  const SIDG = 'sess-G-' + Math.random().toString(36).slice(2);
  const SIDOther = 'sess-OTHER-' + Math.random().toString(36).slice(2);
  const keyG = `s\x00${encDir}\x00${SIDG}`;
  const keyOther = `s\x00${encDir}\x00${SIDOther}`;
  const g = await cdp.eval(`(() => {
    const st = window.__station;
    localStorage.removeItem(st.QUEUE_KEY);
    ${putStore(keyG, ['G-KEEP'])}
    ${putStore(keyOther, ['OTHER-STAY'])}
    ${setCur({ projectId: projId, encodedDir: encDir, sessionId: SIDG })}
    st.resetTranscript();
    const store = JSON.parse(localStorage.getItem(st.QUEUE_KEY) ?? '{}');
    return { texts: st.state.queue.map((q) => q.text), owner: st.queueOwnerKey(), want: st.draftKey(st.state.current),
             otherStillStored: Object.values(store).some((e) => e?.key === ${JSON.stringify(keyOther)}) };
  })()`);
  check('G: only the current session’s row is on the dock (OTHER not pulled in)',
    g.texts.includes('G-KEEP') && !g.texts.includes('OTHER-STAY'), JSON.stringify(g.texts));
  check('G: ownership is the current key, not the other session’s', g.owner === g.want, JSON.stringify({ owner: g.owner, want: g.want }));
  check('G: the OTHER session’s stored rows are left intact (not deleted, not migrated)', g.otherStillStored, JSON.stringify({ otherStillStored: g.otherStillStored }));

  /* H. ROUTE-TO-NO-SESSION — state.current becomes {projectId, sessionId:null}; reset re-binds to p\0<proj>.
     Attack: does it resurrect an abandoned queue, or (worse) pull another project's rows? */
  console.log('\n=== H. route resolves to no session: does reset resurrect / cross-contaminate? ===');
  const otherProjKey = `p\x00OTHER-PROJECT-ID`;
  const h = await cdp.eval(`(() => {
    const st = window.__station;
    localStorage.removeItem(st.QUEUE_KEY);
    ${putStore(`p\x00${projId}`, ['ABANDONED-PENDING'])}
    ${putStore(otherProjKey, ['FOREIGN-PROJECT-ROW'])}
    ${setCur({ projectId: projId, encodedDir: null, sessionId: null })}
    st.resetTranscript();
    return { texts: st.state.queue.map((q) => q.text), owner: st.queueOwnerKey(), want: st.draftKey(st.state.current) };
  })()`);
  check('H: reset binds to THIS project’s pending-new key, never the foreign project key',
    h.owner === h.want && h.owner === `p\x00${projId}`, JSON.stringify({ owner: h.owner, want: h.want }));
  check('H: no FOREIGN project row is ever pulled onto the dock (no cross-project contamination)',
    !h.texts.includes('FOREIGN-PROJECT-ROW'), JSON.stringify(h.texts));
  // Characterization (not necessarily a defect): the project's own pending-new rows DO reappear.
  console.log(`        [note] project pending-new rows on the dock after route-to-no-session: ${JSON.stringify(h.texts)}`);

  /* I. RESET WITH NO OWNABLE CURRENT SESSION — must not throw, must bind null, must touch nothing. */
  console.log('\n=== I. reset with no ownable current (projectId null): null binding, no throw, no deletion ===');
  const i = await cdp.eval(`(() => {
    const st = window.__station;
    localStorage.removeItem(st.QUEUE_KEY);
    ${putStore(`s\x00${encDir}\x00keepme`, ['BYSTANDER'])}
    ${setCur({ projectId: null, encodedDir: null, sessionId: null })}
    let threw = null; try { st.resetTranscript(); } catch (e) { threw = String(e && e.message || e); }
    const store = JSON.parse(localStorage.getItem(st.QUEUE_KEY) ?? '{}');
    return { threw, owner: st.queueOwnerKey(), bystanderIntact: Object.values(store).some((e) => e?.key === ${JSON.stringify(`s\x00${encDir}\x00keepme`)}) };
  })()`);
  check('I: reset did not throw with no ownable current session', i.threw === null, JSON.stringify({ threw: i.threw }));
  check('I: ownership is null (nothing to own)', !i.owner, JSON.stringify({ owner: i.owner }));
  check('I: an unrelated stored session’s rows are left intact', i.bystanderIntact, JSON.stringify({ bystanderIntact: i.bystanderIntact }));

  await cdp.send('Fetch.disable');
  cdp.on.delete('Fetch.requestPaused');
  cdp.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => { console.error(`\nFATAL: ${err.message}`); process.exitCode = 1; })
  .finally(() => {
    stopByPid(browser); stopByPid(server);
    setTimeout(() => { for (const d of cleanupDirs) fs.rmSync(d, { recursive: true, force: true }); process.exit(process.exitCode ?? 0); }, 2500);
  });
