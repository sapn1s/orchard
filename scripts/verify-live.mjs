/**
 * Tail-fetch, live-follow and live-detection checks.
 *
 *   npm run verify:live
 *
 * Two servers: one on the user's REAL store (for the 286 MB tail + live
 * detection against genuine sessions), one on a temp CLAUDE_PROJECTS_DIR where
 * appends can be driven deterministically. Nothing in the real store is written.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';
import { homeEncoded } from './lib/neighbor-project.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const REAL_PORT = 4324;
const TMP_PORT = 4325;
const REAL_STORE = path.join(os.homedir(), '.claude', 'projects');
const BIG_DIR = '-workspace';
const BIG_SID = 'b933f622-623c-4a42-a212-d07a3aa0ca8c';
const DATA1 = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-live-d1-'));
const DATA2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-live-d2-'));
const TMPSTORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-live-store-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, obs) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}\n        observed: ${obs}`); ok ? pass++ : fail++; };
const section = (t) => console.log(`\n=== ${t} ===`);
const j = async (base, p) => (await fetch(base + p)).json();

function boot(port, data, env = {}) {
  const s = spawn(process.execPath, [path.join(ROOT, 'src/server/index.ts')], {
    cwd: ROOT, env: { ...process.env, PORT: String(port), CLAUDE_STATION_DATA: data, ...env },
    stdio: ['ignore', 'ignore', 'pipe'], detached: true,
  });
  s.stderr.on('data', (d) => process.stderr.write(`  [server!:${port}] ${d}`));
  return s;
}
const servers = [];
/** Dirs the spawned CLI creates in the user's REAL store; swept in finally. */
const realStoreDirsToRemove = [];
function events(ws) { const a = []; ws.on('message', (m) => a.push(JSON.parse(String(m)))); return a; }
const waitEv = async (a, pred, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const h = a.find(pred); if (h) return h; await sleep(100); } return null; };

try {
  const s1 = boot(REAL_PORT, DATA1); servers.push(s1);
  const s2 = boot(TMP_PORT, DATA2, { CLAUDE_PROJECTS_DIR: TMPSTORE }); servers.push(s2);
  const B1 = `http://127.0.0.1:${REAL_PORT}`, B2 = `http://127.0.0.1:${TMP_PORT}`;
  for (const b of [B1, B2]) for (let i = 0; i < 80; i++) { try { await fetch(`${b}/api/health`); break; } catch { await sleep(250); } }

  section('1. ?tail=N reaches the true end of the 286 MB session');
  const bigPath = path.join(REAL_STORE, BIG_DIR, `${BIG_SID}.jsonl`);
  if (!fs.existsSync(bigPath)) throw new Error(`precondition failed: ${bigPath} missing`);
  const bigSize = fs.statSync(bigPath).size;
  check('PRECONDITION: the file really is far larger than the 128 MiB forward budget', bigSize > 200 * 1024 * 1024, `${(bigSize / 1048576).toFixed(1)} MiB`);

  // Ground truth: last main-thread entry physically present at EOF.
  const tb = Buffer.alloc(Math.min(8 * 1024 * 1024, bigSize));
  const fd = fs.openSync(bigPath, 'r'); fs.readSync(fd, tb, 0, tb.length, bigSize - tb.length); fs.closeSync(fd);
  let truth = null;
  const tlines = tb.toString('utf8').split('\n').filter(Boolean);
  for (let i = tlines.length - 1; i >= 0 && !truth; i--) {
    try { const o = JSON.parse(tlines[i]); if ((o.type === 'user' || o.type === 'assistant') && o.isSidechain !== true && o.isMeta !== true) truth = o; } catch { /* torn */ }
  }
  if (!truth) throw new Error('precondition failed: could not read a ground-truth last message from EOF');

  // Shallow forward reads are cheap now (early-stop), so probe the END: a deep
  // offset is where the 128 MiB budget genuinely cannot reach — the reason the
  // newest messages looked unreachable.
  const totalProbe = (await j(B1, `/api/transcript/${BIG_DIR}/${BIG_SID}?tail=1`)).total;
  const fwd = await j(B1, `/api/transcript/${BIG_DIR}/${BIG_SID}?limit=3&offset=${totalProbe - 3}`);
  check(
    'BASELINE: forward paging still cannot reach the newest messages (this is why the session looked broken)',
    fwd.budgetExhausted === true && fwd.messages.length === 0 && fwd.unreachableForward > 0,
    `?offset=${totalProbe - 3}: budgetExhausted=${fwd.budgetExhausted}, msgs=${fwd.messages.length}, forwardReachable=${fwd.forwardReachableMessages} of total=${fwd.total}, unreachableForward=${fwd.unreachableForward}`,
  );

  const t0 = Date.now();
  const tail = await j(B1, `/api/transcript/${BIG_DIR}/${BIG_SID}?tail=50`);
  const coldMs = Date.now() - t0;
  const t1 = Date.now();
  const tail2 = await j(B1, `/api/transcript/${BIG_DIR}/${BIG_SID}?tail=50`);
  const warmMs = Date.now() - t1;
  check(
    '?tail=50 returns exactly 50 messages and its newest IS the newest on disk',
    tail.messages.length === 50 && tail.messages.at(-1).uuid === truth.uuid,
    `newest returned uuid=${tail.messages.at(-1).uuid} ts=${tail.messages.at(-1).timestamp}; ground truth uuid=${truth.uuid} ts=${truth.timestamp}`,
  );
  check(
    'and it is O(N): a fraction of the file is read, not 128 MiB',
    tail.bytesRead <= 4 * 1024 * 1024 && tail.budgetExhausted === false,
    `bytesRead=${(tail.bytesRead / 1024).toFixed(0)} KiB of ${(tail.fileBytes / 1048576).toFixed(0)} MiB (${((100 * tail.bytesRead) / tail.fileBytes).toFixed(3)}%), cold=${coldMs}ms warm=${warmMs}ms`,
  );
  check(
    'the tail exposes exact total + absolute indices so the client can splice',
    tail.total > 50 && tail.totalIsLowerBound === false && tail.offset === tail.total - 50 && tail.messages.at(-1).index === tail.total - 1 && tail.hasMore === true,
    `total=${tail.total} lowerBound=${tail.totalIsLowerBound} offset=${tail.offset} lastIndex=${tail.messages.at(-1).index} hasMore=${tail.hasMore}`,
  );
  check(
    'the tail reaches content the forward route cannot serve at ANY offset',
    fwd.budgetExhausted === true && fwd.messages.length === 0 && Date.parse(tail.messages.at(-1).timestamp) > 0,
    `forward @deep-offset returned ${fwd.messages.length} msgs (budget-exhausted); tail's newest=${tail.messages.at(-1).timestamp} reachable only via ?tail`,
  );
  check('repeat tail is consistent', tail2.messages.at(-1).uuid === tail.messages.at(-1).uuid && tail2.total === tail.total, `uuid stable=${tail2.messages.at(-1).uuid === tail.messages.at(-1).uuid}, total=${tail2.total}`);

  // total must agree with the paginated route on a file that fits in budget.
  const HOME_ENC = homeEncoded(); // encoded store dir for $HOME itself — derived, not hardcoded (FEAT-049)
  const small = fs.readdirSync(path.join(REAL_STORE, HOME_ENC)).filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ f, s: fs.statSync(path.join(REAL_STORE, HOME_ENC, f)).size })).filter((x) => x.s > 50_000 && x.s < 5_000_000).sort((a, b) => b.s - a.s)[0];
  if (!small) throw new Error('precondition failed: no mid-sized session to cross-check total against');
  const sid = small.f.slice(0, -6);
  /*
   * NOTE: readSession's `scannedMessages` is NOT a total — it is "qualifying
   * messages seen while scanning", so with limit=1 it stops at 1-2. Comparing
   * `total` against it was a bad check and it failed loudly (total=916 vs
   * scanned=2). The real cross-check is a FULL read: ask for more messages than
   * the file has and count what actually comes back.
   */
  const full = await j(B1, `/api/transcript/${HOME_ENC}/${sid}?limit=1000&offset=0`);
  check(
    'exact `total` equals what a full paginated read actually returns',
    full.budgetExhausted === false && full.hasMore === false && full.total === full.messages.length,
    `${sid.slice(0, 8)} (${(small.s / 1024).toFixed(0)} KiB): total=${full.total} messagesReturned=${full.messages.length} hasMore=${full.hasMore} budgetExhausted=${full.budgetExhausted}`,
  );

  section('1b. tail and forward are ONE coordinate system (the reported bug)');
  /*
   * The reported bug: ?tail and ?offset numbered the same messages differently
   * (604-608 vs 911-915; total 609 vs scanned 916). Canonical space is now
   * renderable-filtered, shared by tail, forward and count. Cross-check: forward
   * ?offset=K&limit=1 is byte-identical to the tail message at absolute index K.
   */
  // One mid-size home session + the single LARGEST transcript in the whole
  // store (the deep-tail case) — both discovered on this machine (FEAT-049).
  const biggest = (() => {
    let best = null;
    for (const d of fs.readdirSync(REAL_STORE, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      for (const f of fs.readdirSync(path.join(REAL_STORE, d.name))) {
        if (!f.endsWith('.jsonl')) continue;
        const sz = fs.statSync(path.join(REAL_STORE, d.name, f)).size;
        if (!best || sz > best.sz) best = { d: d.name, f, sz };
      }
    }
    return best;
  })();
  if (!biggest) throw new Error('precondition failed: no transcripts in the real store');
  for (const [label, D, S] of [
    [sid.slice(0, 8), HOME_ENC, sid],
    [`${biggest.f.slice(0, 8)} (${(biggest.sz / 1048576).toFixed(0)}MB)`, biggest.d, biggest.f.slice(0, -6)],
  ]) {
    const tl = await j(B1, `/api/transcript/${D}/${S}?tail=5`);
    let allMatch = true, detail = '';
    for (const mm of tl.messages) {
      const f = await j(B1, `/api/transcript/${D}/${S}?offset=${mm.index}&limit=1`);
      const fm = f.messages[0];
      if (!(fm && fm.index === mm.index && fm.uuid === mm.uuid)) { allMatch = false; detail += ` idx${mm.index}:tail=${mm.uuid?.slice(0, 8)}/fwd=${fm?.uuid?.slice(0, 8)}`; }
    }
    check(
      `${label}: forward ?offset=K === tail index=K, same message same index`,
      allMatch && tl.offset === tl.total - tl.messages.length && tl.messages.at(-1).index === tl.total - 1,
      `total=${tl.total} tailIndices=[${tl.messages.map((m) => m.index)}]${allMatch ? ' — all reconciled' : ' — MISMATCH' + detail}`,
    );
  }

  section('1c. byte-cursor scroll-up on the 286 MB file is O(page size) and reaches the deep-middle forward cannot');
  let page = await j(B1, `/api/transcript/${BIG_DIR}/${BIG_SID}?tail=200`);
  let prevFirst = page.messages[0].index, cursor = page.cursorBytes, maxBytes = 0, pages = 1, gap = false;
  for (let p = 0; p < 25 && page.messages.length; p++) {
    const nx = await j(B1, `/api/transcript/${BIG_DIR}/${BIG_SID}?tail=200&beforeBytes=${cursor}&before=${prevFirst}`);
    if (!nx.messages.length) break;
    if (nx.messages.at(-1).index !== prevFirst - 1) gap = true;
    maxBytes = Math.max(maxBytes, nx.bytesRead); pages++;
    prevFirst = nx.messages[0].index; cursor = nx.cursorBytes; page = nx;
  }
  check(
    'scroll-up pages are contiguous and each reads a small, flat number of bytes',
    !gap && maxBytes < 8 * 1024 * 1024 && pages > 10,
    `${pages} pages, deepest index ${prevFirst}, MAX bytes/page = ${(maxBytes / 1024).toFixed(0)} KiB (a from-EOF re-read would grow to hundreds of MiB)`,
  );
  const deepFwd = await j(B1, `/api/transcript/${BIG_DIR}/${BIG_SID}?offset=${prevFirst}&limit=1`);
  const deepBack = await j(B1, `/api/transcript/${BIG_DIR}/${BIG_SID}?tail=1&before=${prevFirst + 1}`);
  check(
    'the deep region is reachable by the backward cursor where forward ?offset is budget-exhausted',
    deepFwd.budgetExhausted === true && deepFwd.messages.length === 0 && deepBack.messages.length === 1 && deepBack.messages[0].index === prevFirst,
    `at index ${prevFirst}: forward budgetExhausted=${deepFwd.budgetExhausted} msgs=${deepFwd.messages.length}; backward returned index ${deepBack.messages[0]?.index}`,
  );

  section('2. ?tail=N on the subagent route');
  const withSub = fs.readdirSync(REAL_STORE, { withFileTypes: true }).flatMap((d) => {
    if (!d.isDirectory()) return [];
    return fs.readdirSync(path.join(REAL_STORE, d.name), { withFileTypes: true })
      .filter((c) => c.isDirectory() && fs.existsSync(path.join(REAL_STORE, d.name, c.name, 'subagents')))
      .map((c) => ({ dir: d.name, sid: c.name }));
  })[0];
  if (!withSub) throw new Error('precondition failed: no session with subagents in the store');
  const agents = await j(B1, `/api/sessions/${withSub.sid}/subagents?dir=${withSub.dir}`);
  const ag = agents.subagents.find((a) => a.messageCount > 6) ?? agents.subagents[0];
  const subFull = await j(B1, `/api/sessions/${withSub.sid}/subagents/${ag.agentId}/messages?dir=${withSub.dir}&limit=2000`);
  const subTail = await j(B1, `/api/sessions/${withSub.sid}/subagents/${ag.agentId}/messages?dir=${withSub.dir}&tail=3`);
  check(
    'subagent ?tail=3 returns the same last 3 messages the full read ends with',
    subTail.messages.length === Math.min(3, subFull.messages.length) &&
      subTail.messages.at(-1).uuid === subFull.messages.at(-1).uuid &&
      subTail.total === subFull.messages.length,
    `agent ${ag.agentId}: tail last uuid=${subTail.messages.at(-1).uuid}, full last uuid=${subFull.messages.at(-1).uuid}, tail.total=${subTail.total}, full returned=${subFull.messages.length}, bytesRead=${subTail.bytesRead}`,
  );

  section('3. live detection: genuinely-being-written vs idle');
  const liveNow = await j(B1, '/api/sessions/live');
  check('the live endpoint is cheap enough to poll', liveNow.tookMs < 500, `scanned the whole ${(fs.readdirSync(REAL_STORE).length)}-dir store in ${liveNow.tookMs}ms`);
  // Ground truth from the filesystem, computed independently of the server.
  const now = Date.now();
  const trulyLive = [];
  for (const d of fs.readdirSync(REAL_STORE, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(REAL_STORE, d.name))) {
      if (!f.endsWith('.jsonl')) continue;
      try { if (now - fs.statSync(path.join(REAL_STORE, d.name, f)).mtimeMs <= 30_000) trulyLive.push(`${d.name}/${f.slice(0, -6)}`); } catch { /* gone */ }
    }
  }
  const reported = liveNow.sessions.map((s) => `${s.dir}/${s.sessionId}`);
  check(
    'the reported live set matches an independent filesystem check',
    trulyLive.every((x) => reported.includes(x)) && reported.every((x) => trulyLive.includes(x)),
    `server: ${JSON.stringify(reported.map((x) => x.slice(0, 40)))}\n        fs:     ${JSON.stringify(trulyLive.map((x) => x.slice(0, 40)))}`,
  );
  const idle = `${BIG_DIR}/${BIG_SID}`;
  check(
    'a genuinely-idle session is NOT flagged live (a stale badge is worse than none)',
    !reported.includes(idle),
    `${idle.slice(0, 40)} last written ${((Date.now() - fs.statSync(bigPath).mtimeMs) / 86400000).toFixed(1)} days ago; in live set = ${reported.includes(idle)}`,
  );

  section('4. follow: appends stream, and only the delta is read');
  const dir = 'follow-test';
  const fsid = '11111111-2222-3333-4444-555555555555';
  fs.mkdirSync(path.join(TMPSTORE, dir), { recursive: true });
  const fpath = path.join(TMPSTORE, dir, `${fsid}.jsonl`);
  const mk = (role, text, i) => JSON.stringify({
    type: role, uuid: `u${i}`, parentUuid: null, timestamp: new Date().toISOString(), cwd: '/tmp/x', sessionId: fsid,
    message: role === 'assistant' ? { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text }] } : { role: 'user', content: text },
  }) + '\n';
  // Pre-fill so the file is non-trivial and the cursor starts past it.
  let filler = '';
  for (let i = 0; i < 500; i++) filler += mk('user', `old message ${i} ${'x'.repeat(400)}`, i);
  fs.writeFileSync(fpath, filler);
  const preSize = fs.statSync(fpath).size;

  const ws = new WebSocket(`ws://127.0.0.1:${TMP_PORT}/ws`);
  const ev = events(ws);
  await new Promise((r, j2) => { ws.once('open', r); ws.once('error', j2); });
  ws.send(JSON.stringify({ type: 'follow', sessionId: fsid, dir }));
  const fstat = await waitEv(ev, (e) => e.t === 'follow-status', 10000);
  check('follow starts from the file\'s current end', fstat?.following === true, `follow-status=${JSON.stringify(fstat)}; file was ${(preSize / 1024).toFixed(0)} KiB at follow time`);

  fs.appendFileSync(fpath, mk('assistant', 'FIRST-APPEND-SENTINEL', 1001));
  const b1 = await waitEv(ev, (e) => e.t === 'session-appended', 10000);
  check(
    'an append produces session-appended carrying ONLY the new message',
    !!b1 && b1.messages.length === 1 && b1.messages[0].blocks.some((x) => x.text?.includes('FIRST-APPEND-SENTINEL')) && b1.sessionId === fsid && b1.dir === dir,
    `messages=${b1?.messages.length} sessionId=${b1?.sessionId} dir=${b1?.dir} text=${JSON.stringify(b1?.messages[0]?.blocks[0]?.text)}`,
  );
  check(
    'the byte cursor means the append read only the DELTA, not the file',
    !!b1 && b1.bytesRead < 2000 && b1.fileBytes > preSize,
    `bytesRead=${b1?.bytesRead} B for an append onto a ${(b1?.fileBytes / 1024).toFixed(0)} KiB file (a rescan would have read ${(b1?.fileBytes / 1024).toFixed(0)} KiB)`,
  );
  // The pre-fill wrote 500 renderable user messages, so canonical total is 500
  // and the first appended message must be index 500 — a REAL index in the same
  // space as tail/forward, not the -1 sentinel it used to carry.
  const canonTotal = (await j(B2, `/api/transcript/${dir}/${fsid}?limit=1&offset=0`)).total;
  check(
    'an appended message carries a REAL absolute index continuing the sequence (was -1)',
    !!b1 && b1.messages[0].index === canonTotal - 1 && b1.messages[0].index >= 0,
    `appended index=${b1?.messages[0]?.index}; file's canonical total is now ${canonTotal} (so the newest index is ${canonTotal - 1})`,
  );

  // Burst: several lines written quickly must be coalesced, not dropped.
  const n0 = ev.filter((e) => e.t === 'session-appended').length;
  let burst = '';
  for (let i = 0; i < 5; i++) burst += mk('assistant', `BURST-${i}`, 2000 + i);
  fs.appendFileSync(fpath, burst);
  await sleep(1200);
  const burstBatches = ev.filter((e) => e.t === 'session-appended').slice(n0);
  const burstMsgs = burstBatches.flatMap((b) => b.messages);
  check(
    'a burst of 5 appends is debounced into few batches and loses nothing',
    burstMsgs.length === 5 && burstBatches.length <= 3,
    `${burstBatches.length} batch(es), ${burstMsgs.length} messages: ${JSON.stringify(burstMsgs.map((m) => m.blocks[0]?.text))}`,
  );
  check(
    'the burst messages keep incrementing the absolute index (no gaps, no -1)',
    burstMsgs.every((m, i) => m.index === b1.messages[0].index + 1 + i),
    `first append idx=${b1.messages[0].index}, burst indices=[${burstMsgs.map((m) => m.index)}]`,
  );

  // A live-appended tool_use must carry its input in `text` (the same fix as the
  // history path — one shared converter).
  const nTool = ev.filter((e) => e.t === 'session-appended').length;
  const toolLine = JSON.stringify({
    type: 'assistant', uuid: 'utool', parentUuid: null, timestamp: new Date().toISOString(), cwd: '/tmp/x', sessionId: fsid,
    message: { role: 'assistant', model: 'claude-x', content: [{ type: 'tool_use', id: 'toolu_live1', name: 'Bash', input: { command: 'npm test --silent' } }] },
  }) + '\n';
  fs.appendFileSync(fpath, toolLine);
  const bTool = await waitEv(ev, (e) => e.t === 'session-appended' && ev.filter((x) => x.t === 'session-appended').indexOf(e) >= nTool && e.messages.some((m) => m.blocks.some((x) => x.type === 'tool_use')), 10000);
  const tuBlock = bTool?.messages.flatMap((m) => m.blocks).find((x) => x.type === 'tool_use');
  check(
    'a live-appended tool_use carries its input in `text` (chip can show the command)',
    !!tuBlock && tuBlock.toolName === 'Bash' && JSON.parse(tuBlock.text).command === 'npm test --silent',
    `tool_use block: toolName=${tuBlock?.toolName} text=${JSON.stringify(tuBlock?.text)}`,
  );

  // Partial line: the CLI writes a record in pieces. Must not emit a torn message.
  const n1 = ev.filter((e) => e.t === 'session-appended').length;
  const whole = mk('assistant', 'SPLIT-RECORD-SENTINEL', 3000);
  fs.appendFileSync(fpath, whole.slice(0, 40));
  await sleep(600);
  const midway = ev.filter((e) => e.t === 'session-appended').slice(n1);
  fs.appendFileSync(fpath, whole.slice(40));
  const b3 = await waitEv(ev, (e) => e.t === 'session-appended' && e.messages.some((m) => m.blocks.some((x) => x.text?.includes('SPLIT-RECORD-SENTINEL'))), 10000);
  check(
    'a record split across two writes is buffered and emitted once, whole',
    midway.flatMap((b) => b.messages).length === 0 && !!b3,
    `batches while the line was incomplete: ${midway.length} (0 messages); completed batch delivered=${!!b3}`,
  );

  // Truncation must resync, not throw or splice.
  fs.writeFileSync(fpath, mk('user', 'AFTER-TRUNCATION', 4000));
  const b4 = await waitEv(ev, (e) => e.t === 'session-appended' && e.resynced === true, 10000);
  check(
    'truncation/rotation resyncs and says so, instead of throwing or splicing',
    !!b4 && b4.resynced === true,
    `resynced=${b4?.resynced}, messages=${JSON.stringify(b4?.messages.map((m) => m.blocks[0]?.text))}, fileBytes=${b4?.fileBytes}`,
  );
  const health2 = await j(B2, '/api/health');
  check('the server survived all of that', health2.ok === true, `watches=${health2.watches}`);

  section('5. watches are released — a leaked fs.watch is a real leak');
  ws.send(JSON.stringify({ type: 'unfollow' }));
  await waitEv(ev, (e) => e.t === 'ack' && e.of === 'unfollow', 5000);
  await sleep(300);
  const afterUnfollow = (await j(B2, '/api/health')).watches;
  check('unfollow closes the watch', afterUnfollow === 0, `watches after unfollow = ${afterUnfollow}`);

  const ws2 = new WebSocket(`ws://127.0.0.1:${TMP_PORT}/ws`);
  const ev2 = events(ws2);
  await new Promise((r, j2) => { ws2.once('open', r); ws2.once('error', j2); });
  ws2.send(JSON.stringify({ type: 'follow', sessionId: fsid, dir }));
  await waitEv(ev2, (e) => e.t === 'follow-status', 5000);
  const during = (await j(B2, '/api/health')).watches;
  ws2.close();
  await sleep(600);
  const afterDisconnect = (await j(B2, '/api/health')).watches;
  check('a disconnect releases the watch too', during === 1 && afterDisconnect === 0, `watches during=${during}, after socket close=${afterDisconnect}`);

  section('6. no double-emit for a session the dashboard is driving');
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-live-proj-'));
  const proj = (await (await fetch(`${B2}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: wd, name: 'Live Proj' }) })).json()).project;
  const ws3 = new WebSocket(`ws://127.0.0.1:${TMP_PORT}/ws`);
  const ev3 = events(ws3);
  await new Promise((r, j2) => { ws3.once('open', r); ws3.once('error', j2); });
  ws3.send(JSON.stringify({ type: 'start', projectId: proj.id, prompt: 'Reply with exactly the word: ok' }));
  const init3 = await waitEv(ev3, (e) => e.t === 'session-init', 240000);
  if (!init3) throw new Error('precondition failed: dashboard-driven session never initialised');
  await waitEv(ev3, (e) => e.t === 'turn-end', 240000);
  // Ask a SECOND socket to follow that same session file.
  const ws4 = new WebSocket(`ws://127.0.0.1:${TMP_PORT}/ws`);
  const ev4 = events(ws4);
  await new Promise((r, j2) => { ws4.once('open', r); ws4.once('error', j2); });
  const storeDir = wd.replace(/[^a-zA-Z0-9]/g, '-');
  ws4.send(JSON.stringify({ type: 'follow', sessionId: init3.sessionId, dir: storeDir }));
  const fs4 = await waitEv(ev4, (e) => e.t === 'follow-status', 10000);
  check(
    'following a dashboard-driven session is REFUSED, with the reason — the bridge is already the source of truth',
    fs4?.following === false && /source of truth/.test(fs4?.reason ?? ''),
    `follow-status=${JSON.stringify(fs4)}`,
  );
  const watchesNow = (await j(B2, '/api/health')).watches;
  check('and no watch was created for it', watchesNow === 0, `watches=${watchesNow}, liveBridges=${(await j(B2, '/api/health')).liveBridges}`);
  ws3.send(JSON.stringify({ type: 'close' }));
  ws3.close(); ws4.close(); ws.close();
  fs.rmSync(wd, { recursive: true, force: true });
  /*
   * The spawned `claude` CLI writes its transcript into the REAL store —
   * CLAUDE_PROJECTS_DIR is session-history.ts's own convention, not something
   * the CLI honours. Left unswept, every run of this harness deposits another
   * `-tmp-cs-live-proj-*` directory in the user's history. Registered for
   * cleanup rather than assumed away.
   */
  realStoreDirsToRemove.push(path.join(REAL_STORE, storeDir));
} catch (err) {
  fail++;
  console.error(`\nHARNESS ERROR: ${err.stack}`);
} finally {
  await sleep(500);
  for (const s of servers) { try { process.kill(-s.pid, 'SIGTERM'); } catch { /* gone */ } }
  await sleep(1200);
  for (const s of servers) { try { process.kill(-s.pid, 'SIGKILL'); } catch { /* gone */ } }
  for (const d of [DATA1, DATA2, TMPSTORE]) fs.rmSync(d, { recursive: true, force: true });
  for (const d of realStoreDirsToRemove) {
    try { fs.rmSync(d, { recursive: true, force: true }); console.log(`  cleanup: removed ${d}`); }
    catch (e) { console.log(`  CLEANUP FAILED: ${d}: ${e.message}`); }
  }
  const strays = fs.readdirSync(REAL_STORE).filter((n) => n.startsWith('-tmp-cs-live-proj-'));
  if (strays.length) { fail++; console.log(`  CLEANUP FAILED — stray store dirs remain: ${JSON.stringify(strays)}`); }
  console.log(`\n============ live/tail checks: ${pass} passed, ${fail} failed ============`);
  process.exit(fail ? 1 : 0);
}
