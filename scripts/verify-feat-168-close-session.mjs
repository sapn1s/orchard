#!/usr/bin/env node
/**
 * FEAT-168 — mark a session CLOSED (done), proven by running.
 *
 *   node scripts/verify-feat-168-close-session.mjs
 *
 * DESIGN UNDER TEST (round 6): `closed` is an ORCHARD-owned per-session record in
 * Orchard's data dir (src/server/session-closed.ts) holding the identity of the
 * session's latest INPUT-PROMPT record at close time; a session READS closed iff
 * that is still its latest input prompt (session-mutations readLastPromptKey, an
 * authoritative backward JSONL walk). Nothing writes on reopen: any prompt, by any
 * route, lands in the transcript and flips the answer. Pin stays on the SDK tag;
 * pin and closed are INDEPENDENT. Close/reopen never write the transcript.
 *
 * Every session is created in a throwaway store under $TMPDIR (CLAUDE_CONFIG_DIR =
 * what the SDK's tag API resolves against; CLAUDE_PROJECTS_DIR = what
 * session-history reads; CLAUDE_STATION_DATA = Orchard's data dir), so nothing
 * reaches ~/.claude/projects or the live server's data:
 *
 *   A. SERVER (spawned, isolated, free port). close/reopen via /close and PATCH;
 *      PERSISTS across real restarts; the transcript BYTES are hashed before/after
 *      every close/reopen and never change; the fact lives in the data-dir store;
 *      pin and closed are independent (close a pinned session keeps the pin, pin a
 *      closed one keeps closed, PATCH both at once); closing a LIVE session is
 *      allowed; a FOREIGN tag survives close/reopen (bytes identical); orphan and
 *      corrupt store records never break anything.
 *   B. THE DERIVED READ, graded on REAL record shapes lifted from the user's store:
 *      which records reopen a closed session (input prompts: SDK, typed, mid-turn
 *      queued) and which do not (replies, tool turns, task notifications, interrupt
 *      markers, local commands, hook feedback, compaction, rename, pin, ...); the
 *      commit rule; reopen/re-close; clock skew; an unreadable transcript.
 *   RP. The watermark reader on the REAL store: oracle agreement, a "every real
 *      conversation has a recognised prompt" canary, cold truncation + warm growth
 *      grading on a copy of a real transcript.
 *   C. DOM (real public/app.js in happy-dom): the cap / "N more" / expanded /
 *      currently-open-visible rules, the busy 36-row sidebar, pinned+closed.
 *   D/E/R. Pin's tag reader: round-1/2/3 attacks, truncation grading, the real
 *      store (read-only) — plus round 4's E14/E15: the round-3 cache attack
 *      (same-inode in-place rewrite that regrows and keeps the 256-byte boundary
 *      fingerprint) and a same-size/same-mtime in-place rewrite.
 *   W/SR/G/O/S. E2E ROUTES on isolated scratch servers with the scripted CLI
 *      (which records each prompt in the transcript, modern shape): ws send (live),
 *      ws start+resume (non-live), sendGated -> broker.deliver on an adopt-gated
 *      broker after a restart (round 5's break), the server-owned outbox, and
 *      deliverIntoSurvivor — each leaves the session reading OPEN, no route code.
 *   F/N/T. A fork (source stays closed), a fresh session, viewing, rename, pin do
 *      NOT reopen; a prompt typed in a terminal (no Orchard route at all) DOES.
 *
 * MUST-FAIL: round-6 rows are graded against a SYNTHESIZED round-5 read ("a
 * record exists", rows labelled B-MF) and — for the E2E routes — by running this
 * suite with FEAT168_SERVER_TREE pointing at a reconstructed round-5 tree (G, F2,
 * T1 must FAIL there; recorded in the ticket). Older rows keep their own
 * synthesized baselines (the round-1..3 tag-slot close, the round-3 cache).
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Window } from 'happy-dom';
import WebSocket from 'ws';
import { isolatedServerEnv } from './lib/station-boot.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-feat168-'));
const STORE = path.join(TMP, 'store');
const PROJECTS = path.join(STORE, 'projects');
const DATA = path.join(TMP, 'data');
const WORK = path.join(TMP, 'work');
const REAL_STORE = path.join(os.homedir(), '.claude', 'projects');
const CLOSED_STORE = path.join(DATA, 'session-closed.json');

// The SDK's tag API resolves by CLAUDE_CONFIG_DIR; session-history by
// CLAUDE_PROJECTS_DIR; session-closed.ts by CLAUDE_STATION_DATA. Set all three in
// THIS process too, so in-process module imports use the same throwaway dirs.
process.env.CLAUDE_CONFIG_DIR = STORE;
process.env.CLAUDE_PROJECTS_DIR = PROJECTS;
process.env.CLAUDE_STATION_DATA = DATA;

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  ok ? pass++ : (fail++, failures.push(name));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const HOUR = 3600 * 1000;
const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function encodeCwd(cwd) { return cwd.replace(/[^a-zA-Z0-9]/g, '-'); }
const DIR = path.join(PROJECTS, encodeCwd(WORK));
const fileOf = (id) => path.join(DIR, `${id}.jsonl`);

function backdate(file, minutes = 120) {
  const t = new Date(Date.now() - minutes * 60_000);
  fs.utimesSync(file, t, t);
}
/** A real two-line session file with a recorded cwd (what resolveSession needs). */
function writeSession(id, { aiTitle, tag, live = false } = {}) {
  fs.mkdirSync(DIR, { recursive: true });
  const now = new Date(Date.now() - HOUR).toISOString();
  const u1 = `${id.slice(0, 8)}-1111-4111-8111-111111111111`;
  const lines = [
    { parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: `first prompt of ${id}` }, timestamp: now, uuid: u1, isMeta: false, userType: 'external', entrypoint: 'cli', cwd: WORK, sessionId: id, version: '2.1.158', gitBranch: 'main' },
    { parentUuid: u1, isSidechain: false, type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'a reply' }] }, timestamp: now, uuid: `${id.slice(0, 8)}-2222-4222-8222-222222222222`, cwd: WORK, sessionId: id, version: '2.1.158', gitBranch: 'main' },
  ];
  if (aiTitle) lines.push({ type: 'ai-title', aiTitle, sessionId: id });
  if (tag) lines.push({ type: 'tag', tag, sessionId: id });
  const file = fileOf(id);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  if (!live) backdate(file);
  return file;
}

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

const S_CLOSE = 'cccccccc-1111-4111-8111-000000000001';
const S_PIN = 'cccccccc-1111-4111-8111-000000000002'; // pre-pinned, then closed
const S_LIVE = 'cccccccc-1111-4111-8111-000000000003'; // mtime-fresh (live)
const S_LIVE2 = 'cccccccc-1111-4111-8111-000000000006'; // mtime-fresh, untagged — pin-refusal contrast
const S_UNIT = 'cccccccc-1111-4111-8111-000000000004'; // layer-B id-guard probe
const S_CROWN = 'cccccccc-1111-4111-8111-000000000005'; // layer-C crown sync (r6)
const S_RENAME = 'cccccccc-1111-4111-8111-000000000010'; // layer-A rename/pin of a closed session (r6)
const S_FOREIGN = 'cccccccc-1111-4111-8111-000000000007'; // carries a tag Orchard never wrote
const S_FOREIGN_LIVE = 'cccccccc-1111-4111-8111-000000000008'; // foreign tag + live
const S_LIVE3 = 'cccccccc-1111-4111-8111-000000000009'; // close-only PATCH on a live session
const S_BOTH = 'cccccccc-1111-4111-8111-00000000000a'; // PATCH {pinned, closed} together
const S_PINLATER = 'cccccccc-1111-4111-8111-00000000000b'; // closed first, then pinned
const S_DELETE = 'cccccccc-1111-4111-8111-00000000000c'; // closed, then deleted (orphan)
const S_MF = 'cccccccc-1111-4111-8111-00000000000d'; // must-FAIL baselines (tag-slot close)
const S_MFPIN = 'cccccccc-1111-4111-8111-00000000000e';
const S_MFFOREIGN = 'cccccccc-1111-4111-8111-00000000000f';
const S_ORPHAN = 'dddddddd-0000-4000-8000-0000000000aa'; // never had a transcript

let server = null;
let PORT = 0;
let BASE = '';

async function startServer() {
  server = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    // scripts/lib/station-boot.mjs asserts the isolation (scratch data dir AND
    // scratch transcript store) before the server can run.
    env: isolatedServerEnv({ PORT: String(PORT), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_CONFIG_DIR: STORE, CLAUDE_PROJECTS_DIR: PROJECTS }, { requireStore: true }),
    stdio: ['ignore', 'ignore', 'pipe'], detached: true,
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  for (let i = 0; i < 100; i++) { try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch { /* wait */ } await sleep(100); }
  throw new Error('server never became healthy');
}
async function stopServer() {
  if (!server?.pid) return;
  try { process.kill(-server.pid, 'SIGTERM'); } catch { /* gone */ }
  await sleep(400);
  try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ }
  server = null;
}
async function req(method, p, body) {
  const r = await fetch(`${BASE}${p}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json; const text = await r.text();
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  return { status: r.status, json };
}
const listOf = (json, id) => (json.sessions ?? []).find((s) => s.sessionId === id);
const storeIds = () => { try { return Object.keys(JSON.parse(fs.readFileSync(CLOSED_STORE, 'utf8')).closed ?? {}); } catch { return null; } };

/**
 * SYNTHESIZED PRE-FIX close (rounds 1-3): the closed label written into the SDK's
 * single tag slot with the SDK's own tagSession — exactly the write round 1-3's
 * setClosed made. Used only on dedicated baseline sessions, to prove each new
 * check BITES: the pre-fix mechanism changes transcript bytes, clears a pin, and
 * destroys a foreign tag. (Round 3 refused instead of destroying — that baseline
 * is graded too: the close then FAILS, so "close succeeds AND the tag survives"
 * is false either way.)
 */
async function preFixTagSlotClose(id) {
  const { tagSession } = await import('@anthropic-ai/claude-agent-sdk');
  await tagSession(id, 'closed', { dir: WORK });
}

async function serverLayer(projectId) {
  console.log('\n===== A. server: Orchard-owned closed label =====');
  const dq = `dir=${encodeURIComponent(encodeCwd(WORK))}`;
  const list = async () => (await req('GET', `/api/projects/${projectId}/sessions`)).json;

  // ---- MUST-FAIL baselines (synthesized pre-fix: the tag-slot close) ----
  {
    const h0 = sha(fileOf(S_MF));
    await preFixTagSlotClose(S_MF);
    check('A-MF1 MUST-FAIL baseline: the pre-fix tag-slot close CHANGES the transcript bytes (so the hash checks below bite)',
      sha(fileOf(S_MF)) !== h0, `changed=${sha(fileOf(S_MF)) !== h0}`);
    await preFixTagSlotClose(S_MFPIN);
    let l = await list();
    check('A-MF2 MUST-FAIL baseline: the pre-fix tag-slot close CLEARS a pin (so the independence checks below bite)',
      listOf(l, S_MFPIN)?.pinned === false, `pinned=${listOf(l, S_MFPIN)?.pinned} tag=${listOf(l, S_MFPIN)?.tag}`);
    await preFixTagSlotClose(S_MFFOREIGN);
    l = await list();
    check('A-MF3 MUST-FAIL baseline: the pre-fix tag-slot close DESTROYS a foreign tag (so the foreign-tag checks below bite)',
      listOf(l, S_MFFOREIGN)?.tag !== 'external-triage', `tag=${listOf(l, S_MFFOREIGN)?.tag}`);
    check('A-MF4 the round-4 list does NOT read a transcript tag "closed" as closed (closed is Orchard\'s fact, not the tag)',
      listOf(l, S_MF)?.closed === false && listOf(l, S_MF)?.tag === 'closed', `closed=${listOf(l, S_MF)?.closed} tag=${listOf(l, S_MF)?.tag}`);
  }

  // non-vacuity: a freshly-created session is NOT closed.
  let l = await list();
  check('A0: a new session reports closed:false (non-vacuity of the flag)',
    listOf(l, S_CLOSE)?.closed === false, `closed=${listOf(l, S_CLOSE)?.closed}`);

  const h = sha(fileOf(S_CLOSE));
  const mt = fs.statSync(fileOf(S_CLOSE)).mtimeMs;
  let r = await req('POST', `/api/sessions/${S_CLOSE}/close?${dq}`, {});
  check('A1: POST /close returns 200 and session.closed=true',
    r.status === 200 && r.json.session?.closed === true, `status=${r.status} closed=${r.json.session?.closed}`);
  check('A1b: closing did NOT change the transcript (sha256 + mtime identical)',
    sha(fileOf(S_CLOSE)) === h && fs.statSync(fileOf(S_CLOSE)).mtimeMs === mt, `same=${sha(fileOf(S_CLOSE)) === h}`);
  check('A1c: the fact lives in Orchard\'s data dir (session-closed.json names the session)',
    (storeIds() ?? []).includes(S_CLOSE), `store=${JSON.stringify(storeIds())}`);
  l = await list();
  check('A2: the session list now reports closed:true',
    listOf(l, S_CLOSE)?.closed === true, `closed=${listOf(l, S_CLOSE)?.closed}`);

  await stopServer();
  await startServer();
  l = await list();
  check('A3: closed SURVIVES a full server restart',
    listOf(l, S_CLOSE)?.closed === true, `closed=${listOf(l, S_CLOSE)?.closed}`);

  r = await req('DELETE', `/api/sessions/${S_CLOSE}/close?${dq}`, {});
  check('A4: DELETE /close reopens (closed=false), transcript unchanged',
    r.status === 200 && r.json.session?.closed === false && sha(fileOf(S_CLOSE)) === h, `status=${r.status} closed=${r.json.session?.closed} same=${sha(fileOf(S_CLOSE)) === h}`);
  await stopServer(); await startServer();
  l = await list();
  check('A5: reopened state also survives a restart',
    listOf(l, S_CLOSE)?.closed === false, `closed=${listOf(l, S_CLOSE)?.closed}`);

  r = await req('PATCH', `/api/sessions/${S_CLOSE}?${dq}`, { closed: true });
  check('A6: PATCH {closed:true} also closes, transcript unchanged',
    r.status === 200 && r.json.session?.closed === true && sha(fileOf(S_CLOSE)) === h, `status=${r.status} closed=${r.json.session?.closed}`);
  r = await req('PATCH', `/api/sessions/${S_CLOSE}?${dq}`, { closed: false });
  check('A6b: PATCH {closed:false} reopens, transcript unchanged across the whole close/reopen/restart cycle',
    r.status === 200 && r.json.session?.closed === false && sha(fileOf(S_CLOSE)) === h, `closed=${r.json.session?.closed} same=${sha(fileOf(S_CLOSE)) === h}`);

  // ---- pin and closed are INDEPENDENT ----
  const hp = sha(fileOf(S_PIN));
  r = await req('POST', `/api/sessions/${S_PIN}/close?${dq}`, {});
  check('A7: closing a PINNED session keeps the pin (closed=true AND pinned=true), transcript unchanged',
    r.status === 200 && r.json.session?.closed === true && r.json.session?.pinned === true && sha(fileOf(S_PIN)) === hp,
    `status=${r.status} closed=${r.json.session?.closed} pinned=${r.json.session?.pinned}`);
  await stopServer(); await startServer();
  l = await list();
  check('A7b: after a restart it is still both pinned and closed',
    listOf(l, S_PIN)?.closed === true && listOf(l, S_PIN)?.pinned === true, `closed=${listOf(l, S_PIN)?.closed} pinned=${listOf(l, S_PIN)?.pinned}`);
  r = await req('DELETE', `/api/sessions/${S_PIN}/close?${dq}`, {});
  check('A8: reopening it leaves it PINNED',
    r.json.session?.closed === false && r.json.session?.pinned === true, `closed=${r.json.session?.closed} pinned=${r.json.session?.pinned}`);
  await req('POST', `/api/sessions/${S_PINLATER}/close?${dq}`, {});
  r = await req('POST', `/api/sessions/${S_PINLATER}/pin?${dq}`, {});
  check('A8b: pinning a CLOSED session keeps it closed (closed=true AND pinned=true)',
    r.status === 200 && r.json.session?.closed === true && r.json.session?.pinned === true, `status=${r.status} closed=${r.json.session?.closed} pinned=${r.json.session?.pinned}`);
  r = await req('DELETE', `/api/sessions/${S_PINLATER}/pin?${dq}`, {});
  check('A8c: unpinning it leaves it closed', r.json.session?.closed === true && r.json.session?.pinned === false, `closed=${r.json.session?.closed} pinned=${r.json.session?.pinned}`);
  // Round 6: Orchard's own METADATA writes append records to the transcript but are not a
  // prompt, so they must not reopen (the derived read ignores them). A8b above is the pin.
  {
    await req('POST', `/api/sessions/${S_RENAME}/close?${dq}`, {});
    const h0 = sha(fileOf(S_RENAME));
    const rr = await req('PATCH', `/api/sessions/${S_RENAME}?${dq}`, { title: 'renamed while closed' });
    const tagged = fs.readFileSync(fileOf(S_RENAME), 'utf8').includes('"custom-title"');
    check('A11: RENAMING a closed session (a custom-title record appended to its transcript) leaves it CLOSED',
      rr.status === 200 && rr.json.session?.closed === true && sha(fileOf(S_RENAME)) !== h0 && tagged, `status=${rr.status} closed=${rr.json.session?.closed} appended=${tagged} code=${rr.json.code ?? ''}`);
    const pr = await req('POST', `/api/sessions/${S_RENAME}/pin?${dq}`, {});
    check('A11b: PINNING it too (a tag record appended) still leaves it CLOSED', pr.status === 200 && pr.json.session?.closed === true && pr.json.session?.pinned === true, `status=${pr.status} closed=${pr.json.session?.closed} pinned=${pr.json.session?.pinned}`);
  }
  r = await req('PATCH', `/api/sessions/${S_BOTH}?${dq}`, { pinned: true, closed: true });
  check('A8d: one PATCH {pinned:true, closed:true} sets BOTH (no longer a conflicting op)',
    r.status === 200 && r.json.session?.closed === true && r.json.session?.pinned === true, `status=${r.status} code=${r.json.code} closed=${r.json.session?.closed} pinned=${r.json.session?.pinned}`);

  // ---- LIVE sessions: close allowed; pin still refused (pin behaviour unchanged) ----
  const hl = sha(fileOf(S_LIVE));
  r = await req('POST', `/api/sessions/${S_LIVE}/close?${dq}`, {});
  check('A9: closing a LIVE session is allowed (no 409 — close is a label), transcript unchanged',
    r.status === 200 && r.json.session?.closed === true && sha(fileOf(S_LIVE)) === hl, `status=${r.status} closed=${r.json.session?.closed} code=${r.json.code}`);
  const rp = await req('POST', `/api/sessions/${S_LIVE2}/pin?${dq}`, {});
  check('A10: contrast — pinning a fresh LIVE session IS refused (409 live-session; pin unchanged)',
    rp.status === 409 && rp.json.code === 'live-session', `status=${rp.status} code=${rp.json.code}`);
  r = await req('PATCH', `/api/sessions/${S_LIVE3}?${dq}`, { closed: true });
  check('A10b: close-only PATCH {closed:true} on a LIVE session is allowed (same contract as POST /close)',
    r.status === 200 && r.json.session?.closed === true, `status=${r.status} code=${r.json.code}`);

  // ---- P1: a FOREIGN tag survives close / reopen (it is never read or written) ----
  const fFile = fileOf(S_FOREIGN);
  const f0 = sha(fFile);
  const results = [];
  for (const [label, method, p, body, wantClosed] of [
    ['POST /close', 'POST', `/api/sessions/${S_FOREIGN}/close?${dq}`, {}, true],
    ['DELETE /close', 'DELETE', `/api/sessions/${S_FOREIGN}/close?${dq}`, {}, false],
    ['POST /close?force=1', 'POST', `/api/sessions/${S_FOREIGN}/close?${dq}&force=1`, {}, true],
    ['DELETE /close?force=1', 'DELETE', `/api/sessions/${S_FOREIGN}/close?${dq}&force=1`, {}, false],
    ['PATCH {closed:true}', 'PATCH', `/api/sessions/${S_FOREIGN}?${dq}`, { closed: true }, true],
    ['PATCH {closed:false}', 'PATCH', `/api/sessions/${S_FOREIGN}?${dq}`, { closed: false }, false],
  ]) {
    const rr = await req(method, p, body);
    const ok = rr.status === 200 && rr.json.session?.closed === wantClosed && rr.json.session?.tag === 'external-triage' && sha(fFile) === f0;
    results.push(ok);
    check(`P1 ${label} on a foreign-tagged session: succeeds, closed=${wantClosed}, foreign tag intact, transcript bytes identical`,
      ok, `status=${rr.status} closed=${rr.json.session?.closed} tag=${rr.json.session?.tag} same=${sha(fFile) === f0} code=${rr.json.code ?? ''}`);
  }
  const flFile = fileOf(S_FOREIGN_LIVE);
  const fl0 = sha(flFile);
  r = await req('POST', `/api/sessions/${S_FOREIGN_LIVE}/close?${dq}`, {});
  check('P1 LIVE session with a foreign tag: close succeeds, transcript bytes identical',
    r.status === 200 && r.json.session?.closed === true && sha(flFile) === fl0, `status=${r.status} closed=${r.json.session?.closed} same=${sha(flFile) === fl0}`);

  // ---- orphans and a corrupt store never break anything ----
  r = await req('POST', `/api/sessions/${S_ORPHAN}/close`, {});
  check('O1: closing an id with NO transcript is refused (404) and mints no record',
    r.status === 404 && !(storeIds() ?? []).includes(S_ORPHAN), `status=${r.status} code=${r.json.code}`);
  // A closed session whose transcript is then deleted leaves an orphan record.
  await req('POST', `/api/sessions/${S_DELETE}/close?${dq}`, {});
  r = await req('DELETE', `/api/sessions/${S_DELETE}?${dq}&confirm=${S_DELETE}`, {});
  const delOk = r.status === 200;
  // And a hand-planted orphan for an id that never existed.
  await stopServer();
  const cur = JSON.parse(fs.readFileSync(CLOSED_STORE, 'utf8'));
  cur.closed[S_ORPHAN] = new Date().toISOString();
  fs.writeFileSync(CLOSED_STORE, JSON.stringify(cur));
  await startServer();
  l = await list();
  const lr = await req('GET', `/api/projects/${projectId}/sessions`);
  check('O2: with orphan records (a deleted closed session + a never-existing id) the server boots and the list is intact',
    delOk && lr.status === 200 && !listOf(l, S_DELETE) && !listOf(l, S_ORPHAN) && listOf(l, S_PINLATER)?.closed === true && listOf(l, S_CLOSE)?.closed === false,
    `delete=${r.status} list=${lr.status} rows=${(l.sessions ?? []).length} pinlater.closed=${listOf(l, S_PINLATER)?.closed}`);
  r = await req('POST', `/api/sessions/${S_CLOSE}/close?${dq}`, {});
  const r2 = await req('DELETE', `/api/sessions/${S_CLOSE}/close?${dq}`, {});
  check('O3: close/reopen still work with orphans present', r.status === 200 && r.json.session?.closed === true && r2.json.session?.closed === false, `close=${r.status} reopen=${r2.status}`);
  // Corrupt store: reads degrade to "nothing closed"; the next write preserves the bytes aside.
  fs.writeFileSync(CLOSED_STORE, '{"closed": {"torn');
  l = await list();
  const degraded = (l.sessions ?? []).length > 0 && (l.sessions ?? []).every((s) => s.closed === false);
  r = await req('POST', `/api/sessions/${S_CLOSE}/close?${dq}`, {});
  const quarantined = fs.readdirSync(DATA).filter((f) => f.startsWith('session-closed.json.corrupt-'));
  check('O4: a torn store degrades to "nothing closed" (no crash), and the next close quarantines the bytes rather than clobbering them',
    degraded && r.status === 200 && r.json.session?.closed === true && quarantined.length === 1 && fs.readFileSync(path.join(DATA, quarantined[0]), 'utf8') === '{"closed": {"torn',
    `degraded=${degraded} close=${r.status} quarantined=${quarantined.length}`);
  await req('DELETE', `/api/sessions/${S_CLOSE}/close?${dq}`, {});
}

/* =========================================================================
 * B. THE DERIVED READ (round 6). A session reads CLOSED iff its transcript's
 * latest INPUT-PROMPT record is the one recorded at close (session-closed.ts +
 * session-mutations readLastPromptKey). Every record kind below is a REAL record
 * lifted from the user's own store at run time (read-only, re-keyed to a scratch
 * session; never printed) — so the classifier is graded against what the real
 * CLI writes, not what this suite believes it writes. A kind with no real
 * instance on this machine falls back to a labelled SYNTHETIC record.
 *
 * MUST-FAIL (synthesized round-5 read, fixed code, never HEAD): round 5's read
 * was "a record exists" (`map.has(sid)`), cleared only by a hook on a delivery
 * path Orchard drove. A prompt that lands by a route no hook covers (a
 * `claude --resume` typed in a terminal, the adopt-gated broker) leaves it
 * closed — graded on every prompt kind below.
 * ========================================================================= */
const REAL_KINDS = {
  'user prompt via the SDK input (promptSource sdk)': { prompt: true, find: (e) => e.type === 'user' && e.promptSource === 'sdk' && !e.isMeta && !e.isSidechain && e.origin?.kind !== 'task-notification' && hasText(e) },
  'user prompt typed in the CLI (promptSource typed)': { prompt: true, find: (e) => e.type === 'user' && e.promptSource === 'typed' && !e.isMeta && hasText(e) },
  'mid-turn queued prompt (attachment queued_command, commandMode prompt)': { prompt: true, find: (e) => e.type === 'attachment' && e.attachment?.type === 'queued_command' && e.attachment.commandMode === 'prompt' && !e.attachment.isMeta && e.attachment.origin?.kind !== 'peer' },
  'assistant reply': { prompt: false, find: (e) => e.type === 'assistant' && !e.isSidechain },
  'tool_result turn': { prompt: false, find: (e) => e.type === 'user' && Array.isArray(e.message?.content) && e.message.content.length > 0 && e.message.content.every((b) => b?.type === 'tool_result') },
  'background-task notification (promptSource system)': { prompt: false, find: (e) => e.type === 'user' && e.promptSource === 'system' && e.origin?.kind === 'task-notification' },
  'background-task notification (promptSource sdk, origin task-notification)': { prompt: false, find: (e) => e.type === 'user' && e.promptSource === 'sdk' && e.origin?.kind === 'task-notification' },
  'mid-turn queued task-notification (attachment)': { prompt: false, find: (e) => e.type === 'attachment' && e.attachment?.type === 'queued_command' && e.attachment.commandMode === 'task-notification' },
  'interrupt marker "[Request interrupted by user]" (CLI-synthesised)': { prompt: false, find: (e) => e.type === 'user' && !('promptSource' in e) && newCli(e) && textOf(e) === '[Request interrupted by user]' },
  'interrupt by shutdown (interruptedByShutdown)': { prompt: false, find: (e) => e.type === 'user' && e.interruptedByShutdown === true && !('promptSource' in e) },
  'local slash-command wrapper / stdout (CLI-synthesised)': { prompt: false, find: (e) => e.type === 'user' && !('promptSource' in e) && newCli(e) && /^<(command-name|local-command-stdout)>/.test(textOf(e)) },
  'stop-hook feedback (isMeta)': { prompt: false, find: (e) => e.type === 'user' && e.isMeta === true },
  'compact summary (isCompactSummary)': { prompt: false, find: (e) => e.type === 'user' && e.isCompactSummary === true },
  'peer message between Claude sessions (isMeta, origin peer)': { prompt: false, find: (e) => e.type === 'user' && e.origin?.kind === 'peer' },
  'other attachment (deferred tools / reminders)': { prompt: false, find: (e) => e.type === 'attachment' && e.attachment?.type !== 'queued_command' },
  'system record': { prompt: false, find: (e) => e.type === 'system' },
  'queue-operation record': { prompt: false, find: (e) => e.type === 'queue-operation' },
  'last-prompt record': { prompt: false, find: (e) => e.type === 'last-prompt' },
  'ai-title record': { prompt: false, find: (e) => e.type === 'ai-title' },
  'custom-title record (a RENAME)': { prompt: false, find: (e) => e.type === 'custom-title' },
  'tag record (a PIN)': { prompt: false, find: (e) => e.type === 'tag' },
};
function textOf(e) { const c = e.message?.content; return typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : ''; }
function hasText(e) { return textOf(e).trim().length > 0; }
function newCli(e) { const m = /^(\d+)\.(\d+)\.(\d+)/.exec(e.version ?? ''); return !!m && (Number(m[1]) > 2 || (Number(m[1]) === 2 && (Number(m[2]) > 1 || (Number(m[2]) === 1 && Number(m[3]) >= 197)))); }
const SYNTH = {
  'mid-turn queued prompt (attachment queued_command, commandMode prompt)': { type: 'attachment', attachment: { type: 'queued_command', prompt: 'synthetic mid-turn message', commandMode: 'prompt', timestamp: '' }, version: '2.1.286' },
  'interrupt by shutdown (interruptedByShutdown)': { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, interruptedByShutdown: true, version: '2.1.286' },
  'compact summary (isCompactSummary)': { type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'This session is being continued from a previous conversation.' }, version: '2.1.286' },
  'peer message between Claude sessions (isMeta, origin peer)': { type: 'user', isMeta: true, origin: { kind: 'peer' }, promptSource: 'system', message: { role: 'user', content: 'Another Claude session sent a message' }, version: '2.1.286' },
  'tag record (a PIN)': { type: 'tag', tag: 'pinned' },
  'custom-title record (a RENAME)': { type: 'custom-title', customTitle: 'renamed' },
  'background-task notification (promptSource sdk, origin task-notification)': { type: 'user', promptSource: 'sdk', origin: { kind: 'task-notification' }, message: { role: 'user', content: '<task-notification>done</task-notification>' }, version: '2.1.286' },
  'local slash-command wrapper / stdout (CLI-synthesised)': { type: 'user', message: { role: 'user', content: '<local-command-stdout>Set model</local-command-stdout>' }, version: '2.1.286' },
};
/** First real record of each kind from the user's store (newest files first; read-only). */
function discoverRealRecords() {
  const found = {};
  if (!fs.existsSync(REAL_STORE)) return found;
  const files = [];
  for (const d of fs.readdirSync(REAL_STORE)) {
    let ents; try { ents = fs.readdirSync(path.join(REAL_STORE, d)); } catch { continue; }
    for (const f of ents) if (f.endsWith('.jsonl')) { const p = path.join(REAL_STORE, d, f); try { const st = fs.statSync(p); if (st.size < 32 * 1024 * 1024) files.push({ p, m: st.mtimeMs }); } catch { /* raced */ } }
  }
  files.sort((a, b) => b.m - a.m);
  const want = Object.keys(REAL_KINDS);
  for (const { p } of files.slice(0, 1500)) {
    if (want.every((k) => found[k])) break;
    let txt; try { txt = fs.readFileSync(p, 'utf8'); } catch { continue; }
    for (const line of txt.split('\n')) {
      if (!line) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
      for (const k of want) if (!found[k] && REAL_KINDS[k].find(e)) found[k] = e;
    }
  }
  return found;
}
let rekeyN = 0;
/** A copy of a record re-keyed into a scratch session: fresh uuid + now-timestamp, cwd/sessionId rewritten. */
function rekey(rec, sid) {
  const r = JSON.parse(JSON.stringify(rec));
  rekeyN++;
  const ts = new Date(Date.now() + rekeyN).toISOString();
  if ('uuid' in r || r.type === 'user' || r.type === 'assistant' || r.type === 'attachment') r.uuid = `rk-${rekeyN.toString(16).padStart(8, '0')}-4000-8000-${Date.now().toString(16)}`;
  if ('timestamp' in r || r.type === 'user' || r.type === 'attachment') r.timestamp = ts;
  if (r.attachment && 'timestamp' in r.attachment) r.attachment.timestamp = ts;
  if ('sessionId' in r || r.type === 'tag' || r.type === 'custom-title') r.sessionId = sid;
  if ('cwd' in r) r.cwd = WORK;
  return r;
}

async function unitLayer() {
  console.log('\n===== B. the derived read: which records reopen a closed session (REAL record shapes) =====');
  const sc = await import(path.join(ROOT, 'src', 'server', 'session-closed.ts'));
  const smut = await import(path.join(ROOT, 'src', 'server', 'session-mutations.ts'));
  const real = discoverRealRecords();
  const round5Read = (sid) => { try { return sid in (JSON.parse(fs.readFileSync(CLOSED_STORE, 'utf8')).closed ?? {}); } catch { return false; } };
  let n = 0;
  const mkUnit = () => { n++; const id = `bbbbbbbb-1680-4168-8168-${n.toString(16).padStart(12, '0')}`; writeSession(id, { aiTitle: `unit ${n}` }); return id; };
  const realCount = Object.keys(real).length;
  check(`B0: the real store supplied real records for ${realCount}/${Object.keys(REAL_KINDS).length} kinds (the rest are labelled SYNTHETIC)`,
    realCount >= 12, `real kinds: ${realCount}; synthetic: ${Object.keys(REAL_KINDS).filter((k) => !real[k]).join(' | ') || 'none'}`);
  for (const [kind, { prompt }] of Object.entries(REAL_KINDS)) {
    const base = real[kind] ?? SYNTH[kind];
    if (!base) { check(`B ${kind}: a record to test exists`, false, 'no real instance and no synthetic fallback'); continue; }
    const id = mkUnit();
    const file = fileOf(id);
    const target = { sessionId: id, filePath: file };
    sc.setSessionClosed(target, true);
    const before = sc.isSessionClosed(id, file);
    fs.appendFileSync(file, JSON.stringify(rekey(base, id)) + '\n');
    const after = sc.isSessionClosed(id, file);
    const label = real[kind] ? 'REAL' : 'SYNTHETIC';
    check(`B ${prompt ? 'REOPENS' : 'stays closed'} — ${kind} [${label}]`,
      before === true && after === !prompt, `closedBefore=${before} closedAfter=${after}`);
    if (prompt) {
      check(`B-MF MUST-FAIL baseline (round-5 read = "a record exists"): after "${kind}" lands with no Orchard hook, round 5 still reads CLOSED`,
        round5Read(id) === true, `round5Closed=${round5Read(id)}`);
    }
  }
  // Round-6 classifier, inlined, WITH the legacy structural branch this round DELETES.
  // Used to prove the new "legacy records never reopen" rows BITE: round 6 wrongly
  // classified any pre-2.1.197 `user` record — including a CLI-synthesised shutdown
  // interrupt — as an input prompt (the openai round-6 break, adv 3cb6d0e5bcb1).
  const R6_LEGACY_BEFORE = [2, 1, 197];
  const r6Predates = (version) => {
    if (typeof version !== 'string') return true;
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
    if (!m) return true;
    const v = [Number(m[1]), Number(m[2]), Number(m[3])];
    for (let i = 0; i < 3; i++) if (v[i] !== R6_LEGACY_BEFORE[i]) return v[i] < R6_LEGACY_BEFORE[i];
    return false;
  };
  const r6IsObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const r6OriginKind = (v) => (r6IsObj(v) ? v.kind : undefined);
  const preR6InputPrompt = (rec) => {
    if (rec.isSidechain === true) return false;
    if (rec.type === 'user') {
      if (rec.isMeta === true || rec.isCompactSummary === true) return false;
      if (r6OriginKind(rec.origin) === 'task-notification') return false;
      const msg = r6IsObj(rec.message) ? rec.message : null;
      const content = msg ? msg.content : undefined;
      const hasInput = typeof content === 'string' ? content.length > 0 : Array.isArray(content) && content.some((b) => r6IsObj(b) && b.type !== 'tool_result');
      if (!hasInput) return false;
      if ('promptSource' in rec) return rec.promptSource !== 'system';
      return r6Predates(rec.version); // the deleted legacy structural branch
    }
    if (rec.type === 'attachment' && r6IsObj(rec.attachment) && rec.attachment.type === 'queued_command') {
      const a = rec.attachment;
      if (a.isMeta === true || rec.isMeta === true) return false;
      if (r6OriginKind(a.origin) === 'task-notification') return false;
      return a.commandMode === 'prompt';
    }
    return false;
  };

  // Round 7: a record WITHOUT `promptSource` is NEVER an input prompt — the legacy
  // structural branch is gone. The installed CLI is >= 2.1.197 (premise verified in
  // RP2 + the ticket) and every real current-CLI prompt carries promptSource, so a
  // legacy record can only be CLI-synthesised noise or an old-CLI prompt; either way
  // it must NOT auto-reopen a closed session (the safe direction). Two records:
  //   (1) the openai round-6 break — a LEGACY shutdown-interrupt (v2.1.150,
  //       interruptedByShutdown, "[Request interrupted by user]", no promptSource);
  //   (2) a LEGACY plain user prompt (no promptSource field existed).
  // Each must STAY CLOSED now, and each must have been (wrongly) a prompt under round 6.
  {
    const shutdownRec = { type: 'user', uuid: `legacy-shutdown-${n + 1}`, timestamp: new Date().toISOString(), version: '2.1.150', isSidechain: false, interruptedByShutdown: true, message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } };
    const id0 = mkUnit(); const file0 = fileOf(id0);
    sc.setSessionClosed({ sessionId: id0, filePath: file0 }, true);
    fs.appendFileSync(file0, JSON.stringify({ ...shutdownRec, sessionId: id0, cwd: WORK }) + '\n');
    check('B legacy-shutdown-interrupt: a pre-2.1.197 shutdown interrupt (no promptSource) does NOT reopen [SYNTHETIC]',
      sc.isSessionClosed(id0, file0) === true, `closed=${sc.isSessionClosed(id0, file0)}`);
    check('B-MF legacy-shutdown MUST-FAIL baseline: the round-6 classifier (legacy structural branch) WOULD treat it as a prompt (so the new row bites)',
      preR6InputPrompt(shutdownRec) === true, `round6Prompt=${preR6InputPrompt(shutdownRec)}`);

    const id = mkUnit(); const file = fileOf(id);
    const legacyRec = { type: 'user', uuid: `legacy-${id}`, timestamp: new Date().toISOString(), sessionId: id, cwd: WORK, version: '2.1.150', isSidechain: false, message: { role: 'user', content: 'a prompt from an older CLI' } };
    sc.setSessionClosed({ sessionId: id, filePath: file }, true);
    fs.appendFileSync(file, JSON.stringify(legacyRec) + '\n');
    check('B legacy: a pre-2.1.197 user prompt (no promptSource field existed) does NOT reopen — stays closed until the user reopens it [SYNTHETIC]',
      sc.isSessionClosed(id, file) === true, `closed=${sc.isSessionClosed(id, file)}`);
    check('B-MF legacy MUST-FAIL baseline: the round-6 classifier WOULD treat the legacy plain prompt as a prompt (so the new row bites)',
      preR6InputPrompt(legacyRec) === true, `round6Prompt=${preR6InputPrompt(legacyRec)}`);

    const id2 = mkUnit(); const f2 = fileOf(id2);
    sc.setSessionClosed({ sessionId: id2, filePath: f2 }, true);
    fs.appendFileSync(f2, JSON.stringify({ type: 'user', uuid: `side-${id2}`, timestamp: new Date().toISOString(), isSidechain: true, promptSource: 'sdk', version: '2.1.286', message: { role: 'user', content: 'a subagent prompt' } }) + '\n');
    check('B sidechain: a subagent (isSidechain) prompt does NOT reopen [SYNTHETIC]', sc.isSessionClosed(id2, f2) === true, `closed=${sc.isSessionClosed(id2, f2)}`);
  }
  // FEAT-168 round 8 — the two openai round-7 deviations from the contract ("an
  // input prompt is any non-sidechain user record carrying promptSource ≠ system";
  // prompt identity must make every DISTINCT prompt a distinct key). Both were
  // SYNTHETIC (round-8 reality check: 0 of 303,595 real records across 4,324
  // transcripts is an empty-content prompt or a UUID-less prompt) and both made a
  // session WRONGLY stay closed (the safe direction). Each row must-FAILs against
  // the round-7 reader, inlined here (r6IsObj/r6OriginKind defined above).
  {
    const preR7IsPrompt = (rec) => {
      if (rec.isSidechain === true) return false;
      if (rec.type === 'user') {
        if (rec.isMeta === true || rec.isCompactSummary === true) return false;
        if (r6OriginKind(rec.origin) === 'task-notification') return false;
        const msg = r6IsObj(rec.message) ? rec.message : null;
        const content = msg ? msg.content : undefined;
        const hasInput = typeof content === 'string' ? content.length > 0 : Array.isArray(content) && content.some((b) => r6IsObj(b) && b.type !== 'tool_result');
        if (!hasInput) return false; // the round-7 content gate this round removes
        if (!('promptSource' in rec)) return false;
        return rec.promptSource !== 'system';
      }
      if (rec.type === 'attachment' && r6IsObj(rec.attachment) && rec.attachment.type === 'queued_command') {
        const a = rec.attachment;
        if (a.isMeta === true || rec.isMeta === true) return false;
        if (r6OriginKind(a.origin) === 'task-notification') return false;
        return a.commandMode === 'prompt';
      }
      return false;
    };
    const preR7Key = (rec, line) => {
      if (!preR7IsPrompt(rec)) return undefined;
      if (typeof rec.uuid === 'string' && rec.uuid) return `uuid:${rec.uuid}`;
      if (typeof rec.timestamp === 'string' && rec.timestamp) return `ts:${rec.timestamp}`; // the round-7 aliasing branch this round removes
      return `h:${createHash('sha1').update(line).digest('hex')}`;
    };
    const preR7LatestKey = (file) => {
      const text = fs.readFileSync(file, 'utf8');
      const end = text.lastIndexOf('\n'); if (end < 0) return null;
      let key = null;
      for (const line of text.slice(0, end).split('\n')) { let e; try { e = JSON.parse(line); } catch { continue; } if (e && typeof e === 'object' && !Array.isArray(e)) { const k = preR7Key(e, line); if (k !== undefined) key = k; } }
      return key;
    };

    // (1) EMPTY-CONTENT prompt. Seed P1 (uuid first), close (watermark uuid:first),
    // then append a promptSource prompt with uuid:second and an EMPTY content array.
    {
      const id = mkUnit(); const file = fileOf(id);
      fs.appendFileSync(file, JSON.stringify({ type: 'user', uuid: `first-${id}`, timestamp: new Date().toISOString(), promptSource: 'sdk', version: '2.1.286', sessionId: id, cwd: WORK, message: { role: 'user', content: 'the first prompt' } }) + '\n');
      sc.setSessionClosed({ sessionId: id, filePath: file }, true);
      const p2 = { type: 'user', uuid: `second-${id}`, timestamp: new Date().toISOString(), promptSource: 'sdk', version: '2.1.286', sessionId: id, cwd: WORK, message: { role: 'user', content: [] } };
      fs.appendFileSync(file, JSON.stringify(p2) + '\n');
      check('B empty-content: a promptSource prompt with an EMPTY content array (distinct uuid) REOPENS — classification is by field, not content [SYNTHETIC, openai round-7 case 1]',
        sc.isSessionClosed(id, file) === false, `closed=${sc.isSessionClosed(id, file)}`);
      check('B-MF empty-content MUST-FAIL baseline: round 7 rejects empty content, so its latest-prompt key stays uuid:first — it WOULD leave the session closed',
        preR7IsPrompt(p2) === false && preR7LatestKey(file) === `uuid:first-${id}`, `r7IsPrompt=${preR7IsPrompt(p2)} r7LatestKey=${preR7LatestKey(file)}`);
    }

    // (2) UUID-LESS queued prompts sharing a timestamp. Q1 (no uuid, ts T, alpha),
    // close, then a DISTINCT Q2 (no uuid, SAME ts T, beta): must reopen; round 7
    // keys both to ts:T (alias) and would leave it closed.
    {
      const id = mkUnit(); const file = fileOf(id);
      const T = '2026-10-06T12:00:00.000Z';
      const mkq = (prompt) => ({ type: 'attachment', timestamp: T, version: '2.1.286', sessionId: id, cwd: WORK, attachment: { type: 'queued_command', commandMode: 'prompt', prompt, timestamp: T } });
      const q1 = mkq('alpha'); const q2 = mkq('beta');
      const q1line = JSON.stringify(q1), q2line = JSON.stringify(q2);
      fs.appendFileSync(file, q1line + '\n');
      sc.setSessionClosed({ sessionId: id, filePath: file }, true);
      fs.appendFileSync(file, q2line + '\n');
      check('B queued-ts-collision: a SECOND distinct UUID-less queued prompt sharing a timestamp REOPENS (distinct prompts get distinct keys) [SYNTHETIC, openai round-7 case 2]',
        sc.isSessionClosed(id, file) === false, `closed=${sc.isSessionClosed(id, file)}`);
      check('B-MF queued-ts-collision MUST-FAIL baseline: round 7 keys BOTH to ts:T (alias), so the watermark would not change — it WOULD leave the session closed',
        preR7Key(q1, q1line) === `ts:${T}` && preR7Key(q2, q2line) === `ts:${T}`, `r7key(q1)=${preR7Key(q1, q1line)} r7key(q2)=${preR7Key(q2, q2line)}`);
    }

    // (3) BYTE-IDENTICAL UUID-less prompts: the #count ordinal still gives a NEW key
    // for a repeated identical prompt (round 7 would alias the two copies).
    {
      const id = mkUnit(); const file = fileOf(id);
      const q = { type: 'attachment', timestamp: '2026-10-06T13:00:00.000Z', version: '2.1.286', sessionId: id, cwd: WORK, attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'say hi', timestamp: '2026-10-06T13:00:00.000Z' } };
      const line = JSON.stringify(q);
      fs.appendFileSync(file, line + '\n');
      sc.setSessionClosed({ sessionId: id, filePath: file }, true);
      fs.appendFileSync(file, line + '\n'); // a BYTE-IDENTICAL repeat prompt
      check('B identical-repeat: a byte-identical UUID-less prompt appended again REOPENS (#count ordinal distinguishes copy 2 from copy 1) [SYNTHETIC]',
        sc.isSessionClosed(id, file) === false, `closed=${sc.isSessionClosed(id, file)}`);
      check('B-MF identical-repeat MUST-FAIL baseline: round 7 (uuid|ts|hash) keys both copies identically — it WOULD leave the session closed',
        preR7Key(q, line) === 'ts:2026-10-06T13:00:00.000Z', `r7key=${preR7Key(q, line)}`);
    }
  }
  // Commit rule: a prompt record mid-append (no newline yet) has not happened.
  {
    const id = mkUnit(); const file = fileOf(id);
    sc.setSessionClosed({ sessionId: id, filePath: file }, true);
    const rec = JSON.stringify(rekey(real['user prompt via the SDK input (promptSource sdk)'] ?? { type: 'user', promptSource: 'sdk', version: '2.1.286', message: { role: 'user', content: 'x' } }, id));
    fs.appendFileSync(file, rec.slice(0, Math.floor(rec.length / 2)));
    const half = sc.isSessionClosed(id, file);
    fs.appendFileSync(file, rec.slice(Math.floor(rec.length / 2)));
    const noNl = sc.isSessionClosed(id, file);
    fs.appendFileSync(file, '\n');
    const done = sc.isSessionClosed(id, file);
    check('B commit: a prompt record half-written, then complete-without-newline, still reads CLOSED; the newline landing reopens it',
      half === true && noNl === true && done === false, `half=${half} noNewline=${noNl} committed=${done}`);
  }
  // Reopen deletes the record; a re-close records the NEW watermark.
  {
    const id = mkUnit(); const file = fileOf(id);
    const t = { sessionId: id, filePath: file };
    sc.setSessionClosed(t, true);
    const h = sha(file);
    const changed = sc.setSessionClosed(t, false);
    check('B reopen: explicit reopen deletes the record (reads open), transcript untouched',
      changed === true && sc.isSessionClosed(id, file) === false && round5Read(id) === false && sha(file) === h, `changed=${changed} closed=${sc.isSessionClosed(id, file)}`);
    sc.setSessionClosed(t, true);
    fs.appendFileSync(file, JSON.stringify({ type: 'user', uuid: `p2-${id}`, timestamp: new Date().toISOString(), promptSource: 'sdk', version: '2.1.286', message: { role: 'user', content: 'p2' } }) + '\n');
    const opened = sc.isSessionClosed(id, file);
    const re = sc.setSessionClosed(t, true);
    check('B re-close: a session reopened by a prompt can be closed again (new watermark), and reads closed',
      opened === false && re === true && sc.isSessionClosed(id, file) === true, `openedByPrompt=${!opened} reclosed=${re} closed=${sc.isSessionClosed(id, file)}`);
  }
  // No wall clock is compared: a prompt record carrying a timestamp EARLIER than closedAt (CLI clock behind
  // the server's) still reopens; a close whose server clock is far ahead does not hide later prompts.
  {
    const id = mkUnit(); const file = fileOf(id);
    sc.setSessionClosed({ sessionId: id, filePath: file }, true);
    fs.appendFileSync(file, JSON.stringify({ type: 'user', uuid: `skew-${id}`, timestamp: '2001-01-01T00:00:00.000Z', promptSource: 'typed', version: '2.1.286', message: { role: 'user', content: 'from a skewed clock' } }) + '\n');
    check('B skew: a new prompt stamped YEARS before closedAt still reopens (identity, never wall-clock)', sc.isSessionClosed(id, file) === false, `closed=${sc.isSessionClosed(id, file)}`);
  }
  // Unreadable transcript: close refuses (never stores a guessed watermark); reads open.
  {
    let threw = '';
    try { sc.setSessionClosed({ sessionId: 'bbbbbbbb-1680-4168-8168-ffffffffffff', filePath: path.join(TMP, 'nope.jsonl') }, true); } catch (e) { threw = e?.code ?? String(e); }
    check('B unreadable: closing a session whose transcript cannot be read throws transcript-unreadable and stores nothing',
      threw === 'transcript-unreadable' && !round5Read('bbbbbbbb-1680-4168-8168-ffffffffffff'), `threw=${threw}`);
    check('B ids: invalid ids never read closed and never throw', sc.isSessionClosed('../x', fileOf(S_UNIT)) === false && sc.isSessionClosed(null, null) === false, 'ok');
  }
  void smut;
}

async function domLayer(projectId) {
  const crownProject = projectId;
  console.log('\n===== C. sidebar DOM (real app.js) =====');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const win = new Window({ url: `${BASE}/` });
  const doc = win.document;
  doc.write(html.replace(/<link[^>]*>/g, '').replace(/<script[^>]*><\/script>/g, ''));
  doc.close();
  const realFetch = globalThis.fetch;
  win.fetch = (input, init) => realFetch(input.startsWith('http') ? input : BASE + input, init);
  const openSockets = [];
  class TrackedWebSocket extends WebSocket { constructor(...a) { super(...a); this.on('error', () => {}); openSockets.push(this); } }
  win.WebSocket = TrackedWebSocket;
  win.location.host = `127.0.0.1:${PORT}`;
  const prev = { WebSocket: globalThis.WebSocket, fetch: globalThis.fetch, document: globalThis.document, window: globalThis.window, location: globalThis.location };
  globalThis.document = doc; globalThis.window = win; globalThis.WebSocket = win.WebSocket; globalThis.location = win.location; globalThis.fetch = win.fetch;

  try {
    await import(`${path.join(ROOT, 'public', 'app.js')}?ui=${Date.now()}`);
    const qa = (s) => [...doc.querySelectorAll(s)];
    for (let i = 0; i < 200 && qa('#tree button.proj').length === 0; i++) await sleep(50);
    if (qa('#tree button.proj').length === 0) throw new Error('app.js never rendered a project row');

    const S = win.__station;
    const st = S.state;
    const PID = 'p-closed';
    const ENC = encodeCwd(WORK);
    const mk = (id, title, msAgo, extra = {}) => ({ sessionId: id, encodedDir: ENC, displayTitle: title, os: 'linux', lastActivityAt: iso(msAgo), closed: false, pinned: false, ...extra });
    st.projects = [{ id: PID, name: 'ClosedProj', lastActivityAt: iso(HOUR), hostPath: WORK }];
    st.projSort = 'recency'; S.resortProjects();
    st.expanded = new Set([PID]);
    st.seen = new Map();
    st.current = { projectId: null, encodedDir: null, sessionId: null, title: null, os: null };

    const groupOf = () => qa('#tree .pgroup').find((gr) => gr.querySelector('.proj .nm')?.textContent.trim() === 'ClosedProj');
    const rowTitles = (gr) => [...(gr?.querySelectorAll('.kids button.row') ?? [])].map((r) => r.textContent.replace(/\s+/g, ' ').trim());
    const showsIn = (gr, t) => rowTitles(gr).some((s) => s.endsWith(t));
    const moreBtn = (gr) => gr?.querySelector('.kids button.more:not(.less)');

    // Four RECENT sessions; one of them (CDONE) is CLOSED. A fifth, CSHAPE, is a
    // byte-identical twin of CDONE but with the `closed` field STRIPPED — the
    // SYNTHESIZED PRE-CHANGE shape. All five within the cap window.
    const recent = [
      mk('R1', 'R1', 1 * HOUR),
      mk('R2', 'R2', 2 * HOUR),
      mk('CDONE', 'CDONE', 3 * HOUR, { closed: true }),
      mk('R3', 'R3', 4 * HOUR),
    ];
    const shaped = { ...mk('CSHAPE', 'CSHAPE', 3 * HOUR) }; delete shaped.closed; // pre-change row has no field
    const list = [...recent, shaped];
    st.sessions = new Map([[PID, { loaded: true, loading: false, error: null, list, shown: 6, windowed: true, encodedDir: ENC, dirs: [] }]]);
    S.renderTree();
    let gr = groupOf();

    check('C1: a RECENT closed session is EXCLUDED from the default windowed view',
      !showsIn(gr, 'CDONE'), rowTitles(gr));
    check('C2: MUST-FAIL baseline — the same-recency row WITHOUT a closed field SHOWS (pre-change behavior)',
      showsIn(gr, 'CSHAPE'), rowTitles(gr));
    check('C3: ordinary recent (non-closed) rows still show',
      showsIn(gr, 'R1') && showsIn(gr, 'R2') && showsIn(gr, 'R3'), rowTitles(gr));
    check('C4: the closed row folds under "N more"',
      /\bmore\b/.test(moreBtn(gr)?.textContent?.trim() ?? ''), `more=${JSON.stringify(moreBtn(gr)?.textContent?.trim())}`);

    // Expand: closed row appears, in recency order (between R2@2h and R3@4h).
    moreBtn(groupOf())?.click();
    gr = groupOf();
    check('C5: "N more" reveals the closed session',
      showsIn(gr, 'CDONE'), rowTitles(gr));
    const ts = rowTitles(gr);
    const idxC = ts.findIndex((s) => s.endsWith('CDONE'));
    const idxR2 = ts.findIndex((s) => s.endsWith('R2'));
    const idxR3 = ts.findIndex((s) => s.endsWith('R3'));
    check('C6: in the expanded list the closed session keeps recency order (R2 before CDONE before R3)',
      idxR2 >= 0 && idxC > idxR2 && idxR3 > idxC, `R2=${idxR2} CDONE=${idxC} R3=${idxR3}`);
    check('C7: the revealed closed row carries the .closed treatment + marker',
      !!gr.querySelector('.kids button.row.closed .closed-mark'), `has=${!!gr.querySelector('.kids button.row.closed .closed-mark')}`);

    // The currently-OPEN session stays visible even when closed.
    st.current = { projectId: PID, encodedDir: ENC, sessionId: 'CDONE', title: null, os: null };
    st.sessions.set(PID, { loaded: true, loading: false, error: null, list, shown: 6, windowed: true, encodedDir: ENC, dirs: [] });
    S.renderTree();
    check('C8: a CLOSED session that is currently OPEN stays visible in the capped view',
      showsIn(groupOf(), 'CDONE'), rowTitles(groupOf()));

    /* ---- Round 3, P2: a BUSY sidebar (36 recent sessions, every 5th closed, two
     * of the closed ones LIVE but not open, the user viewing closed B0). Success
     * criterion 3 — "the open one stays visible" — is DELIBERATE: the one closed
     * row allowed in the capped view is the one on screen. Everything else closed
     * folds, live or not, and is counted in "N more". The round-2 verifier's
     * "P2 busy CLOSED current row excluded" contradicted criterion 3 (and its own
     * next check); this pins the intended behaviour explicitly instead. */
    const busy = Array.from({ length: 36 }, (_, i) => mk('B' + i, 'B' + i, (i + 1) * 60_000, { closed: i % 5 === 0 }));
    const closedIds = busy.filter((x) => x.closed).map((x) => x.sessionId);
    const liveKeyOf = (id) => `${ENC} ${id}`;
    const prevLive = st.liveIds;
    st.liveIds = new Map([[liveKeyOf('B10'), { sessionId: 'B10', dir: ENC, working: true }], [liveKeyOf('B15'), { sessionId: 'B15', dir: ENC, running: true }], [liveKeyOf('B3'), { sessionId: 'B3', dir: ENC, working: true }]]);
    st.current = { projectId: PID, encodedDir: ENC, sessionId: 'B0', title: null, os: null };
    const bb = { loaded: true, loading: false, error: null, list: busy, shown: 6, windowed: true, encodedDir: ENC, dirs: [] };
    st.sessions.set(PID, bb); S.renderTree();
    let v = S.visibleSessions(bb);
    let ids = v.rows.map((x) => x.sessionId);
    check('P2-1 busy: the OPEN closed session (B0) is the ONLY closed row in the capped view',
      ids.includes('B0') && ids.filter((id) => closedIds.includes(id)).length === 1, ids);
    check('P2-2 busy: closed rows that are LIVE but not open (B10, B15) still fold',
      !ids.includes('B10') && !ids.includes('B15'), ids);
    check('P2-3 busy: a LIVE non-closed row (B3) still bypasses the cap; seats are bounded',
      ids.includes('B3') && ids.length <= 6 + 2, ids);
    check('P2-4 busy: hidden = exactly the rows not shown', v.hidden === busy.length - v.rows.length, `hidden=${v.hidden} rows=${v.rows.length}`);
    check('P2-5 busy (DOM): the rendered capped list shows B0 and none of the other closed rows',
      // every id starts with "B", so endsWith('B<n>') is exact ("…B10" never ends with "B0")
      showsIn(groupOf(), 'B0') && !closedIds.filter((id) => id !== 'B0').some((id) => showsIn(groupOf(), id)), rowTitles(groupOf()));
    // Navigate away: B0 is no longer on screen, so it folds like any closed row.
    st.current = { projectId: PID, encodedDir: ENC, sessionId: 'B1', title: null, os: null };
    S.renderTree();
    v = S.visibleSessions(bb); ids = v.rows.map((x) => x.sessionId);
    check('P2-6 busy: after switching to B1, closed B0 folds too (no closed row left in the capped view)',
      !ids.some((id) => closedIds.includes(id)) && ids.includes('B1'), ids);
    // MUST-FAIL baseline (synthesized pre-feature shape): the same busy list with the
    // `closed` field stripped keeps recent "closed" rows in the capped view.
    const stripped = busy.map((x) => { const y = { ...x }; delete y.closed; return y; });
    const vs = S.visibleSessions({ ...bb, list: stripped });
    check('P2-7 MUST-FAIL baseline: without the closed field, some of those rows WOULD occupy the cap',
      vs.rows.some((x) => closedIds.includes(x.sessionId) && x.sessionId !== 'B1'), vs.rows.map((x) => x.sessionId));
    // Expanded: every closed row present, recency order intact.
    bb.windowed = false; bb.shown = 100; S.renderTree();
    v = S.visibleSessions(bb); ids = v.rows.map((x) => x.sessionId);
    // (the OPEN session, B1, is listed first by design — orderedSessions — so recency
    // is graded over the rest)
    const rest8 = v.rows.filter((x) => x.sessionId !== 'B1');
    check('P2-8 busy expanded: every closed row is revealed, in recency order',
      closedIds.every((id) => ids.includes(id)) && rest8.every((x, i, a) => i === 0 || a[i - 1].lastActivityAt >= x.lastActivityAt), ids.join(','));
    st.liveIds = prevLive;
    st.current = { projectId: PID, encodedDir: ENC, sessionId: 'CDONE', title: null, os: null };
    st.sessions.set(PID, { loaded: true, loading: false, error: null, list, shown: 6, windowed: true, encodedDir: ENC, dirs: [] });

    // Round 4: pin and closed are independent. A PINNED+CLOSED row stays in the
    // pinned block (pin is the user's explicit "keep on top"), rendered with BOTH
    // markers and the muted treatment; a closed-only row of the same recency folds.
    {
      st.current = { projectId: null, encodedDir: null, sessionId: null, title: null, os: null };
      const pl = [mk('PC', 'PC', 5 * HOUR, { pinned: true, closed: true }), mk('R1', 'R1', 1 * HOUR), mk('R2', 'R2', 2 * HOUR), mk('CO', 'CO', 5 * HOUR, { closed: true })];
      st.sessions.set(PID, { loaded: true, loading: false, error: null, list: pl, shown: 6, windowed: true, encodedDir: ENC, dirs: [] });
      S.renderTree();
      const g = groupOf();
      const pcRow = [...(g?.querySelectorAll('.kids button.row') ?? [])].find((r) => r.textContent.trim().endsWith('PC'));
      check('C11: a PINNED+CLOSED row stays visible (pinned block) with BOTH the pin and closed markers + the muted .closed class',
        !!pcRow && pcRow.classList.contains('closed') && pcRow.classList.contains('pinned') && !!pcRow.querySelector('.pin-mark') && !!pcRow.querySelector('.closed-mark'),
        `found=${!!pcRow} class=${pcRow?.className}`);
      check('C12: a closed-only row of the same recency still folds', !showsIn(g, 'CO'), rowTitles(g));
      st.sessions.set(PID, { loaded: true, loading: false, error: null, list, shown: 6, windowed: true, encodedDir: ENC, dirs: [] });
    }

    // (d, sidebar entry point) the row context menu offers Close / Reopen. Driven
    // through the REAL contextmenu path wired in sessionRow (not an exported call).
    st.current = { projectId: null, encodedDir: null, sessionId: null, title: null, os: null };
    S.renderTree();
    gr = groupOf();
    const rowFor = (t) => [...gr.querySelectorAll('.kids button.row')].find((r) => r.textContent.replace(/\s+/g, ' ').trim().endsWith(t));
    const ctx = (el2) => el2.dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
    ctx(rowFor('R1'));
    await sleep(20);
    const menuText = doc.querySelector('#rowMenu')?.textContent ?? '';
    check('C9: the sidebar row menu offers a "Close session" action (entry point)',
      /Close session/.test(menuText), menuText.replace(/\s+/g, ' ').slice(0, 160));

    // Reveal the closed row again, then open its menu.
    const s2 = st.sessions.get(PID); s2.windowed = false; s2.shown = 20; S.renderTree();
    gr = groupOf();
    const rowFor2 = (t) => [...gr.querySelectorAll('.kids button.row')].find((r) => r.textContent.replace(/\s+/g, ' ').trim().endsWith(t));
    ctx(rowFor2('CDONE'));
    await sleep(20);
    const menuText2 = doc.querySelector('#rowMenu')?.textContent ?? '';
    check('C10: on a CLOSED row the same menu offers "Reopen session"',
      /Reopen session/.test(menuText2), menuText2.replace(/\s+/g, ' ').slice(0, 160));

    // Round 6: nothing pushes "reopened" any more. The crown mirrors the server's DERIVED
    // answer: when a turn ends in a session the crown shows closed, the list is re-read and
    // the crown follows it. Driven through the REAL turn-end handler (onEvent).
    {
      const ENC2 = encodeCwd(WORK);
      await req('POST', `/api/sessions/${S_CROWN}/close?dir=${encodeURIComponent(ENC2)}`, {});
      st.current = { projectId: crownProject, encodedDir: ENC2, sessionId: S_CROWN, title: null, os: 'linux', closed: false };
      await S.loadSessions(crownProject, { force: true });
      const lbl = () => doc.querySelector('#closeSessLbl')?.textContent?.trim();
      check('C13: a list load syncs the crown to the server\'s answer (closed on the server -> the crown reads "Reopen")',
        st.current.closed === true && lbl() === 'Reopen', `current.closed=${st.current.closed} label=${lbl()}`);
      fs.appendFileSync(fileOf(S_CROWN), JSON.stringify({ type: 'user', uuid: `crown-${Date.now()}`, timestamp: new Date().toISOString(), promptSource: 'sdk', version: '2.1.286', sessionId: S_CROWN, cwd: WORK, isSidechain: false, message: { role: 'user', content: 'a new message' } }) + '\n');
      try { S.onEvent({ t: 'turn-end', subtype: 'success' }); } catch (e) { check('C14: the turn-end handler ran', false, String(e).slice(0, 200)); }
      for (let i = 0; i < 60 && st.current.closed !== false; i++) await sleep(50);
      check('C14: after a turn that a new prompt started, turn-end re-reads the list and the crown flips to "Close" (no push event needed)',
        st.current.closed === false && lbl() === 'Close', `current.closed=${st.current.closed} label=${lbl()}`);
    }
  } finally {
    try {
      const st2 = win.__station?.state;
      if (st2?.snapPollTimer) { clearInterval(st2.snapPollTimer); st2.snapPollTimer = null; }
      if (st2?.liveTimer) { clearInterval(st2.liveTimer); st2.liveTimer = null; }
    } catch { /* never booted */ }
    for (const s of openSockets) { try { s.on('error', () => {}); s.close(); } catch { /* closed */ } }
    await sleep(150);
    Object.assign(globalThis, prev);
  }
}


/**
 * Round 4: `closed` is no longer a transcript tag, so the reader layers (D/E/R)
 * grade the TAG SLOT reader — pin's reader — directly. In their fixtures the
 * string "closed" is just a tag value like any other; `closed` below means
 * "the reader reports the tag value 'closed'".
 */
function readMeta(smut, file) {
  const m = smut.readTitleMeta(file);
  return { ...m, closed: m.tag === 'closed' };
}

/** {found, tag} of the last COMPLETE tag record in buf (forward parse, oracle rule). */
function lastTagRecord(buf) {
  const s = buf.toString('utf8');
  const lastNl = s.lastIndexOf('\n');
  const complete = lastNl < 0 ? '' : s.slice(0, lastNl);
  let found = false, tag = null;
  for (const raw of complete.split('\n')) {
    let e; try { e = JSON.parse(raw); } catch { continue; }
    if (e && typeof e === 'object' && !Array.isArray(e) && e.type === 'tag') { found = true; tag = typeof e.tag === 'string' && e.tag ? e.tag : null; }
  }
  return { found, tag };
}

/**
 * SYNTHESIZED PRE-FIX state for E14: round 3's incremental tag cache (resolveTag),
 * inlined in behaviour. A hit on ino+size+mtime; for a GROWN same-inode file whose
 * 256 bytes before the previous complete-line end are unchanged, only the appended
 * region is scanned and the cached tag stands when it holds no tag record.
 */
function round3IncrementalReader() {
  let prev = null;
  return (file) => {
    const st = fs.statSync(file);
    const buf = fs.readFileSync(file);
    if (prev && prev.ino === st.ino && prev.size === st.size && prev.mtimeMs === st.mtimeMs) return prev.tag;
    let floor = 0;
    if (prev && prev.ino === st.ino && st.size > prev.size && prev.completeEnd <= st.size && prev.fp.length === Math.min(256, prev.completeEnd)) {
      if (buf.subarray(prev.completeEnd - prev.fp.length, prev.completeEnd).equals(prev.fp)) floor = prev.completeEnd;
    }
    const lastNl = buf.lastIndexOf(0x0a);
    const completeEnd = lastNl < floor ? floor : lastNl + 1;
    const scan = lastTagRecord(buf.subarray(floor, completeEnd));
    const tag = scan.found ? scan.tag : floor > 0 ? prev.tag : null;
    const fpLen = Math.min(256, completeEnd);
    prev = { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, completeEnd, fp: Buffer.from(buf.subarray(completeEnd - fpLen, completeEnd)), tag };
    return tag;
  };
}

/* =========================================================================
 * D. AUTHORITATIVE TAG READER — the property-4 break (round-1 verifier, BROKEN).
 *
 * Round 1 derived closed/pinned from readTitleMeta's head+tail SAMPLING, so the
 * authoritative LATEST tag record is invisible when later turns push it into the
 * unsampled middle of a large transcript, and a tail window starting mid-line can
 * JSON-parse a fragment as a bogus tag. This layer reproduces the verifier's
 * attacks on REALISTIC ~600KB transcripts and grades each TWICE:
 *   - against a SYNTHESIZED pre-fix reader (round-1's exact head+tail tag logic,
 *     inlined here so the must-FAIL baseline is anchored to fixed code, never to
 *     a moving HEAD) — this MUST give the wrong answer, proving the attack bites;
 *   - against the REAL readTitleMeta — this MUST give the correct answer.
 * Plus truncation grading: the real fixture bytes truncated at many points, each
 * compared to an independent "last COMPLETE tag" oracle (CONVENTIONS: if another
 * process writes it, test partial/truncated reads).
 *
 * Needs NO server — imports only session-mutations.ts (+ own-writes.ts). So it
 * runs in a minimal clean room even while the full working tree cannot boot.
 * ========================================================================= */
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 256 * 1024;

/** Round-1's tag resolution, inlined verbatim: head+tail sampling, last-wins. */
function preFixSampledTag(filePath) {
  const st = fs.statSync(filePath);
  let tag = null;
  const scan = (text) => {
    for (const raw of text.split('\n')) {
      if (!raw.includes('"type":"tag"')) continue;
      let e; try { e = JSON.parse(raw); } catch { continue; }
      if (e.type === 'tag') tag = typeof e.tag === 'string' && e.tag ? e.tag : null;
    }
  };
  const fd = fs.openSync(filePath, 'r');
  try {
    if (st.size <= HEAD_BYTES + TAIL_BYTES) {
      const b = Buffer.alloc(st.size); fs.readSync(fd, b, 0, st.size, 0); scan(b.toString('utf8'));
    } else {
      const h = Buffer.alloc(HEAD_BYTES); fs.readSync(fd, h, 0, HEAD_BYTES, 0);
      const t = Buffer.alloc(TAIL_BYTES); fs.readSync(fd, t, 0, TAIL_BYTES, st.size - TAIL_BYTES);
      scan(h.toString('utf8')); scan(t.toString('utf8'));
    }
  } finally { fs.closeSync(fd); }
  return tag;
}

/**
 * Independent oracle: the last COMPLETE (newline-terminated) tag in `buf`.
 * Round 3: FORWARD, whole-string, JSON.parse of EVERY complete line and a decision
 * on the parsed object only — no substring prefilter (round 2's oracle shared the
 * reader's `"type":"tag"` text-shape blind spot, so it could never catch it). It
 * mirrors the SDK's own full-parse semantics:
 *   if (a.type === "tag") { tag = typeof a.tag === "string" && a.tag ? a.tag : none }
 */
function oracleTag(buf) {
  const s = buf.toString('utf8');
  const lastNl = s.lastIndexOf('\n');
  const complete = lastNl < 0 ? '' : s.slice(0, lastNl); // drop any un-terminated final line
  let tag = null;
  for (const raw of complete.split('\n')) {
    let e; try { e = JSON.parse(raw); } catch { continue; }
    if (e && typeof e === 'object' && !Array.isArray(e) && e.type === 'tag') tag = typeof e.tag === 'string' && e.tag ? e.tag : null;
  }
  return tag;
}

/**
 * Round 2's reader, inlined VERBATIM in behaviour (backward whole-line scan that
 * recognised a tag by the TEXT SHAPE `"type":"tag"` before JSON.parse). This is the
 * SYNTHESIZED pre-fix state for layer E's round-3 attacks — anchored to fixed code,
 * never to HEAD (CONVENTIONS: must-FAIL must not use a moving baseline).
 */
function preFixRound2Tag(filePath) {
  const all = fs.readFileSync(filePath);
  const lastNl = all.lastIndexOf(0x0a);
  if (lastNl < 0) return null;
  const lines = all.subarray(0, lastNl).toString('utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.includes('"type":"tag"')) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'tag') return typeof e.tag === 'string' && e.tag ? e.tag : null;
  }
  return null;
}

const advDir = () => { const d = path.join(TMP, 'adv'); fs.mkdirSync(d, { recursive: true }); return d; };
const turnLine = (i) => JSON.stringify({
  parentUuid: null, isSidechain: false, type: i % 2 ? 'assistant' : 'user',
  message: { role: i % 2 ? 'assistant' : 'user', content: i % 2 ? [{ type: 'text', text: 'z'.repeat(360) }] : 'q'.repeat(360) },
  // Deliberately carry the substring "type":"tag" in content on some turns, to
  // prove the reader does not false-positive on it (real transcripts do — a
  // 53MB real file held 1025 such substrings, none of them tag records).
  note: i % 7 === 0 ? 'mentions {"type":"tag","tag":"x"} inside prose' : '',
  timestamp: new Date().toISOString(), uuid: `adv-${i}`, cwd: WORK, sessionId: 'adv', version: '2.1.158',
}) + '\n';

/**
 * Build a realistic transcript. `place` = [{afterBytes, tag}] inserts a real
 * {type:'tag'} record once the running size crosses afterBytes. `trailingPartial`
 * (optional) appends raw bytes with NO newline — a record a writer is mid-append.
 */
function buildTranscript(file, { place = [], targetBytes = 600 * 1024, trailingPartial = null }) {
  const pend = place.map((p) => ({ ...p, done: false }));
  let out = '';
  let i = 0;
  const emit = (line) => { out += line; };
  while (Buffer.byteLength(out) < targetBytes) {
    for (const p of pend) if (!p.done && Buffer.byteLength(out) >= p.afterBytes) {
      emit(JSON.stringify({ type: 'tag', tag: p.tag, sessionId: 'adv' }) + '\n'); p.done = true;
    }
    emit(turnLine(i++));
  }
  for (const p of pend) if (!p.done) { emit(JSON.stringify({ type: 'tag', tag: p.tag, sessionId: 'adv' }) + '\n'); p.done = true; }
  if (trailingPartial) out += trailingPartial; // no newline -> incomplete final record
  fs.writeFileSync(file, out);
  return file;
}

async function advLayer() {
  console.log('\n===== D. authoritative tag reader (property 4) =====');
  const smut = await import(path.join(ROOT, 'src', 'server', 'session-mutations.ts'));
  const dir = advDir();
  const realClosed = (file) => { smut.clearTitleMetaCache(); return readMeta(smut, file).closed; };
  const realTag = (file) => { smut.clearTitleMetaCache(); return readMeta(smut, file).tag; };
  const realPinned = (file) => { smut.clearTitleMetaCache(); return readMeta(smut, file).pinned; };

  // D1 — reopen stranded in the unsampled MIDDLE. close in head, reopen (clear)
  // in the middle, turns in the tail. True state: OPEN.
  const f1 = buildTranscript(path.join(dir, 'd1.jsonl'), { place: [{ afterBytes: 10 * 1024, tag: 'closed' }, { afterBytes: 290 * 1024, tag: '' }] });
  check('D1 MUST-FAIL baseline: sampling reader reads a STALE closed (reopen in middle unseen)',
    preFixSampledTag(f1) === 'closed', `preFixTag=${JSON.stringify(preFixSampledTag(f1))}`);
  check('D1 FIX: authoritative reader reports OPEN (sees the reopen in the middle)',
    realClosed(f1) === false, `closed=${realClosed(f1)}`);

  // D2 — a replacement FOREIGN tag stranded in the middle. True: not closed, not pinned, tag=foreign.
  const f2 = buildTranscript(path.join(dir, 'd2.jsonl'), { place: [{ afterBytes: 10 * 1024, tag: 'closed' }, { afterBytes: 290 * 1024, tag: 'triage' }] });
  check('D2 MUST-FAIL baseline: sampling reader still reads closed (foreign tag in middle unseen)',
    preFixSampledTag(f2) === 'closed', `preFixTag=${JSON.stringify(preFixSampledTag(f2))}`);
  check('D2 FIX: authoritative reader reports the real current tag (foreign) — not closed, not pinned',
    realTag(f2) === 'triage' && realClosed(f2) === false && realPinned(f2) === false,
    `tag=${JSON.stringify(realTag(f2))} closed=${realClosed(f2)} pinned=${realPinned(f2)}`);

  // D3 — a CLOSE stranded in the middle, head+tail are only turns. The user's
  // actual symptom: a session they closed reappears as open. True state: CLOSED.
  const f3 = buildTranscript(path.join(dir, 'd3.jsonl'), { place: [{ afterBytes: 290 * 1024, tag: 'closed' }] });
  check('D3 MUST-FAIL baseline: sampling reader MISSES the close in the middle (reads open)',
    preFixSampledTag(f3) === null, `preFixTag=${JSON.stringify(preFixSampledTag(f3))}`);
  check('D3 FIX: authoritative reader reports CLOSED (the closed session stays hidden)',
    realClosed(f3) === true, `closed=${realClosed(f3)}`);

  // D4 — tail-fragment masquerade. NO real tag record, but the tail window begins
  // exactly at a byte that makes its leading fragment JSON-parse as a closed tag.
  const TAG_FRAG = '{"type":"tag","tag":"closed"}';
  const L1 = Buffer.byteLength(TAG_FRAG);
  const padLen = 300 * 1024; // head+middle filler -> file > HEAD+TAIL
  const base = '{"type":"user","sessionId":"adv","pad":"';
  const suffix = '"}\n';
  const B = TAIL_BYTES - L1 - 1; // bytes after the crafted line's newline, so `{` lands on the tail boundary
  const fillLen = B - Buffer.byteLength(base) - Buffer.byteLength(suffix);
  if (fillLen <= 0) throw new Error('D4 fill math');
  const craftedLine = 'P'.repeat(padLen) + TAG_FRAG + '\n'; // one physical line; not valid JSON as a whole
  const trailingLine = base + 'u'.repeat(fillLen) + suffix;
  const f4 = path.join(dir, 'd4.jsonl');
  fs.writeFileSync(f4, craftedLine + trailingLine);
  check('D4 MUST-FAIL baseline: sampling reader false-positives on the tail fragment (reads closed)',
    preFixSampledTag(f4) === 'closed', `preFixTag=${JSON.stringify(preFixSampledTag(f4))} size=${fs.statSync(f4).size}`);
  check('D4 FIX: authoritative reader rejects the mid-line fragment (reads OPEN)',
    realClosed(f4) === false, `closed=${realClosed(f4)}`);

  // D5 — reopen-in-middle with a TRUNCATED unrelated record mid-append at EOF.
  // The partial write must not corrupt the middle read. True state: OPEN.
  const f5 = buildTranscript(path.join(dir, 'd5.jsonl'), {
    place: [{ afterBytes: 10 * 1024, tag: 'closed' }, { afterBytes: 290 * 1024, tag: '' }],
    trailingPartial: '{"type":"assistant","message":{"role":"assist',
  });
  check('D5 FIX: a truncated trailing record does not break the middle read (OPEN)',
    realClosed(f5) === false, `closed=${realClosed(f5)}`);

  // D6 — reopen-in-middle with a half-written RE-CLOSE tag at EOF (no newline).
  // An un-terminated close has not taken effect. True state: OPEN.
  const f6 = buildTranscript(path.join(dir, 'd6.jsonl'), {
    place: [{ afterBytes: 10 * 1024, tag: 'closed' }, { afterBytes: 290 * 1024, tag: '' }],
    trailingPartial: '{"type":"tag","tag":"clo',
  });
  check('D6 FIX: a half-written re-close tag is ignored until its newline lands (OPEN)',
    realClosed(f6) === false, `closed=${realClosed(f6)}`);

  // D7 — truncation grading of a REAL fixture. Take a transcript whose close
  // record sits where a write could be interrupted, truncate at many byte points
  // spanning that record, and grade EACH against an independent last-complete-tag
  // oracle. The reader must match the oracle at every truncation.
  const base7 = fs.readFileSync(buildTranscript(path.join(dir, 'd7.jsonl'), { place: [{ afterBytes: 40 * 1024, tag: 'closed' }, { afterBytes: 300 * 1024, tag: '' }], targetBytes: 500 * 1024 }));
  const f7 = path.join(dir, 'd7-trunc.jsonl');
  let graded = 0, mism = 0, firstMiss = '';
  const cuts = new Set();
  for (let c = 1024; c < base7.length; c += Math.floor(base7.length / 60)) cuts.add(c);
  // also cut at every byte across the two tag records' neighbourhoods
  for (const needle of ['"tag":"closed"', '"tag":""']) {
    const at = base7.toString('latin1').indexOf(needle);
    if (at > 0) for (let c = Math.max(1, at - 40); c <= at + needle.length + 40 && c < base7.length; c++) cuts.add(c);
  }
  for (const c of cuts) {
    fs.writeFileSync(f7, base7.subarray(0, c));
    smut.clearTitleMetaCache();
    const got = readMeta(smut, f7).tag;
    const want = oracleTag(base7.subarray(0, c));
    graded++;
    if (got !== want) { mism++; if (!firstMiss) firstMiss = `cut=${c} got=${JSON.stringify(got)} want=${JSON.stringify(want)}`; }
  }
  check(`D7: reader matches the last-complete-tag oracle at every truncation (${graded} cuts)`,
    mism === 0, mism === 0 ? `all ${graded} truncations agree` : `${mism}/${graded} mismatches; first ${firstMiss}`);
}

/* =========================================================================
 * E. ROUND-3 READER ATTACKS — the round-2 verifier's second property-4 break.
 *
 * Round 2's reader recognised a tag record by the TEXT SHAPE `"type":"tag"`, so a
 * complete, valid tag record written with whitespace (`{"type": "tag", …}`) or an
 * escaped key/value was invisible and an earlier tag won. Round 3's reader decides
 * on the PARSED object only. Each MUST-FAIL row is graded against the synthesized
 * round-2 reader (preFixRound2Tag) AND the real readTitleMeta; regression-only rows
 * (which round 2 happened to get right) are labelled as such, not as must-FAIL.
 * Also: the warm/incremental cache path, giant lines, and truncation grading
 * against the independent forward-parse oracle.
 * ========================================================================= */
async function readerRound3Layer() {
  console.log('\n===== E. round-3 reader: parsed-object recognition, incremental cache =====');
  const smut = await import(path.join(ROOT, 'src', 'server', 'session-mutations.ts'));
  const dir = path.join(TMP, 'r3'); fs.mkdirSync(dir, { recursive: true });
  const cold = (file) => { smut.clearTitleMetaCache(); return readMeta(smut, file); };
  const filler = (n) => { let s = ''; for (let i = 0; i < n; i++) s += turnLine(i); return s; };
  const compact = (tag) => JSON.stringify({ type: 'tag', tag, sessionId: 'adv' }) + '\n';
  // Realistic size: tags separated by real-shaped turns, file > the 512KB title sample.
  const mkFile = (name, parts) => { const f = path.join(dir, name); fs.writeFileSync(f, parts.join('')); return f; };
  const F = filler(700); // ~550KB of turns

  const mustFail = (id, desc, file, want, field = 'tag') => {
    const pre = preFixRound2Tag(file);
    const preVal = field === 'tag' ? pre : (field === 'closed' ? pre === 'closed' : pre === 'pinned');
    check(`${id} MUST-FAIL baseline (round-2 reader): ${desc}`, preVal !== want, `preFix ${field}=${JSON.stringify(preVal)} want=${JSON.stringify(want)}`);
    const m = cold(file);
    check(`${id} FIX: ${desc}`, m[field] === want, `real ${field}=${JSON.stringify(m[field])} tag=${JSON.stringify(m.tag)}`);
  };
  const regress = (id, desc, file, want, field = 'tag') => {
    const m = cold(file);
    check(`${id} (regression): ${desc}`, m[field] === want && oracleTag(fs.readFileSync(file)) === m.tag,
      `real ${field}=${JSON.stringify(m[field])} oracle=${JSON.stringify(oracleTag(fs.readFileSync(file)))}`);
  };

  // E1 — the verifier's exact case: a WHITESPACE foreign tag supersedes an earlier closed.
  mustFail('E1', 'whitespace foreign tag `{"type": "tag", …}` supersedes an earlier CLOSED (not closed)',
    mkFile('e1.jsonl', [compact('closed'), F, '{"type": "tag", "tag": "triage", "sessionId": "adv"}\n', filler(3)]), false, 'closed');
  // E2 — the verifier's other case: a WHITESPACE closed supersedes an earlier pin.
  mustFail('E2', 'whitespace CLOSED (`{ "type" : "tag" , "tag" : "closed" }`) supersedes an earlier PIN',
    mkFile('e2.jsonl', [compact('pinned'), F, '{ "type" : "tag" , "tag" : "closed" , "sessionId" : "adv" }\n', filler(3)]), true, 'closed');
  // E3 — single-line PRETTY print (JSON.stringify indent, newlines folded to spaces/tabs).
  mustFail('E3', 'single-line pretty-printed (tab/space-indented) clear supersedes CLOSED',
    mkFile('e3.jsonl', [compact('closed'), F, JSON.stringify({ type: 'tag', tag: '', sessionId: 'adv' }, null, '\t').replace(/\n/g, ' ') + '\n', filler(3)]), null);
  // E4 — unicode-ESCAPED key/value: still `type === "tag"` once parsed.
  mustFail('E4', 'unicode-escaped `{"type":"t\\u0061g","tag":"cl\\u006fsed"}` reads CLOSED',
    mkFile('e4.jsonl', [compact('pinned'), F, '{"type":"t\\u0061g","tag":"cl\\u006fsed","sessionId":"adv"}\n', filler(3)]), true, 'closed');
  // E5 — key order reversed (round 2 happened to handle it; kept as regression).
  regress('E5', 'key-reordered `{"tag":"closed","type":"tag"}` after a pin reads CLOSED',
    mkFile('e5.jsonl', [compact('pinned'), F, '{"tag":"closed","sessionId":"adv","type":"tag"}\n', filler(3)]), true, 'closed');
  // E6 — a record pretty-printed ACROSS PHYSICAL LINES is not a JSONL record (the
  // store's format is one record per line; the SDK's own readers agree). It must be
  // ignored without crashing: the earlier CLOSED stands.
  regress('E6', 'a MULTI-LINE pretty-printed tag is not a JSONL record: ignored, earlier CLOSED stands',
    mkFile('e6.jsonl', [compact('closed'), F, JSON.stringify({ type: 'tag', tag: 'triage' }, null, 2) + '\n', filler(3)]), true, 'closed');
  // E7 — a tag-shaped JSON string INSIDE a turn's content must not count (top-level
  // type is "user"). After a real reopen, the session is OPEN.
  regress('E7', 'tag-shaped text inside a user turn\'s content does not count (OPEN after a reopen)',
    mkFile('e7.jsonl', [compact('closed'), F, compact(''), JSON.stringify({ type: 'user', message: { role: 'user', content: '{"type":"tag","tag":"closed"}' }, sessionId: 'adv' }) + '\n',
      JSON.stringify({ type: 'user', payload: { type: 'tag', tag: 'closed' } }) + '\n']), false, 'closed');
  // E8 — non-object JSON lines (null, array, string, number) after CLOSED: no crash, CLOSED stands.
  regress('E8', 'non-object JSON lines (null / [] / "tag" / 42) are skipped, CLOSED stands',
    mkFile('e8.jsonl', [F, compact('closed'), 'null\n', '[{"type":"tag","tag":""}]\n', '"tag"\n', '42\n']), true, 'closed');
  // E9 — CRLF line endings (JSON whitespace includes \r).
  mustFail('E9b', 'CRLF + whitespace record `{"type": "tag", "tag": "closed"}\\r\\n` after a pin reads CLOSED',
    mkFile('e9.jsonl', [compact('pinned'), F, '{"type": "tag", "tag": "closed"}\r\n', filler(2).replace(/\n/g, '\r\n')]), true, 'closed');
  // E10 — the clear forms (null / missing / non-string) all mean cleared, exactly as the SDK.
  for (const [k, rec] of [['null', '{"type":"tag","tag":null}'], ['missing', '{"type":"tag"}'], ['number', '{"type":"tag","tag":5}']]) {
    regress(`E10-${k}`, `a tag record with ${k} value clears an earlier CLOSED`, mkFile(`e10-${k}.jsonl`, [compact('closed'), F, rec + '\n']), null);
  }

  // E11 — the WARM / incremental cache path (readTitleMeta WITHOUT clearing the
  // cache between appends — the live-session reality). Every step graded against
  // the oracle on the bytes actually on disk.
  {
    const f = path.join(dir, 'e11.jsonl');
    smut.clearTitleMetaCache();
    const bump = (ms) => { const t = new Date(Date.now() + ms); fs.utimesSync(f, t, t); };
    let step = 0, bad = '';
    const grade = (label, want) => {
      step++;
      const got = readMeta(smut, f).tag;
      const orc = oracleTag(fs.readFileSync(f));
      if (got !== want || orc !== want) bad ||= `${label}: got=${JSON.stringify(got)} oracle=${JSON.stringify(orc)} want=${JSON.stringify(want)}`;
    };
    fs.writeFileSync(f, compact('closed') + F); grade('cold closed', 'closed');
    fs.appendFileSync(f, filler(40)); bump(1000); grade('grown, no tag -> cached closed stands', 'closed');
    fs.appendFileSync(f, '{"type": "tag", "tag": "", "sessionId": "adv"}\n'); bump(2000); grade('whitespace clear appended', null);
    fs.appendFileSync(f, filler(10)); bump(3000); grade('grown after clear', null);
    fs.appendFileSync(f, '{"type":"tag","tag":"closed"}'); bump(4000); grade('un-terminated close (write in progress) ignored', null);
    fs.appendFileSync(f, '\n'); bump(5000); grade('its newline lands -> closed', 'closed');
    fs.appendFileSync(f, '{"type":"tag","ta'); bump(6000); grade('partial record mid-append', 'closed');
    fs.appendFileSync(f, 'g":"pinned"}\n' + filler(5)); bump(7000); grade('partial completes across the floor -> pinned', 'pinned');
    // truncate-and-REGROW in place (same inode), larger than before, different content
    const ino0 = fs.statSync(f).ino;
    fs.writeFileSync(f, compact('triage') + filler(900)); bump(8000);
    grade(`in-place rewrite+regrow (same inode=${fs.statSync(f).ino === ino0})`, 'triage');
    // shrink
    fs.writeFileSync(f, compact('closed') + filler(5)); bump(9000); grade('shrink -> cold rescan', 'closed');
    // replaced by a new inode (rename over)
    const f2 = f + '.new'; fs.writeFileSync(f2, compact('pinned') + filler(20)); fs.renameSync(f2, f); bump(10000); grade('inode replaced', 'pinned');
    // same size, different bytes, mtime changed
    const cur = fs.readFileSync(f); const alt = Buffer.from(cur.toString('latin1').replace('"tag":"pinned"', '"tag":"closed"'), 'latin1');
    fs.writeFileSync(f, alt); bump(11000); grade('same-size in-place edit', 'closed');
    check(`E11: warm/incremental reads track the oracle through ${step} append/rewrite/shrink/replace steps`, !bad, bad || `all ${step} steps agree`);
  }

  // E14 — ROUND 4: the round-3 verifier's cache attack (run 5f20faa854e1). A warm
  // read, then a SAME-INODE in-place rewrite that changes an earlier tag
  // (pinned -> triage, same length), regrows the file, and leaves the 256 bytes
  // before the old complete-line boundary identical. Round 3's incremental cache
  // (inlined below as the synthesized pre-fix state) skipped the rewritten region
  // and served the stale tag. Round 4 does no cross-change reuse.
  {
    const f = path.join(dir, 'e14.jsonl');
    const body = compact('pinned') + filler(700);
    fs.writeFileSync(f, body);
    const t1 = new Date(Math.floor(Date.now() / 1000) * 1000); fs.utimesSync(f, t1, t1);
    smut.clearTitleMetaCache();
    const r3 = round3IncrementalReader();
    const warm0 = readMeta(smut, f).tag, pre0 = r3(f);
    const ino0 = fs.statSync(f).ino;
    const fd = fs.openSync(f, 'r+');
    const at = Buffer.from(body).indexOf('"tag":"pinned"') + 7;
    fs.writeSync(fd, Buffer.from('triage'), 0, 6, at); // in place, same inode
    fs.closeSync(fd);
    fs.appendFileSync(f, filler(12));                   // regrow
    const t2 = new Date(t1.getTime() + 5000); fs.utimesSync(f, t2, t2);
    const want = oracleTag(fs.readFileSync(f));
    const pre = r3(f);
    check('E14 MUST-FAIL baseline (round-3 incremental cache): serves the STALE tag after the in-place rewrite+regrow',
      warm0 === 'pinned' && pre0 === 'pinned' && fs.statSync(f).ino === ino0 && want === 'triage' && pre === 'pinned', `preFix=${JSON.stringify(pre)} oracle=${JSON.stringify(want)} sameInode=${fs.statSync(f).ino === ino0}`);
    const got = readMeta(smut, f);
    check('E14 FIX: the warm reader (cache NOT cleared) reads the rewritten tag (triage, not pinned)',
      got.tag === 'triage' && got.pinned === false, `real tag=${JSON.stringify(got.tag)} pinned=${got.pinned}`);
  }

  // E15 — ROUND 4: a SAME-SIZE in-place rewrite that also restores the mtime. The
  // pre-round-4 cache key (inode + size + mtime — HEAD's and round 3's) calls that a
  // hit and serves the stale tag; round 4's key adds dev + ctime (ctime cannot be
  // set from userspace), so it misses and rescans.
  {
    const f = path.join(dir, 'e15.jsonl');
    fs.writeFileSync(f, compact('pinned') + filler(30));
    const t = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000); fs.utimesSync(f, t, t);
    smut.clearTitleMetaCache();
    const st0 = fs.statSync(f);
    const before = readMeta(smut, f).tag;
    await sleep(20);
    const buf = fs.readFileSync(f);
    const at = buf.indexOf('"tag":"pinned"') + 7;
    const fd = fs.openSync(f, 'r+'); fs.writeSync(fd, Buffer.from('triage'), 0, 6, at); fs.closeSync(fd);
    fs.utimesSync(f, t, t); // restore the mtime exactly
    const st1 = fs.statSync(f);
    const oldKeyHit = st1.ino === st0.ino && st1.size === st0.size && st1.mtimeMs === st0.mtimeMs;
    check('E15 MUST-FAIL baseline (pre-round-4 key ino+size+mtime): the rewritten file is a cache HIT, so the old reader serves the stale tag',
      before === 'pinned' && oldKeyHit && oracleTag(fs.readFileSync(f)) === 'triage', `oldKeyHit=${oldKeyHit} ctimeChanged=${st1.ctimeMs !== st0.ctimeMs}`);
    const got = readMeta(smut, f).tag;
    check('E15 FIX: the warm reader detects the rewrite (ctime) and reads triage', got === 'triage', `real tag=${JSON.stringify(got)}`);
  }

  // E16 — the cost of choosing correctness: no incremental reuse means a changed
  // file is re-scanned in full. Measured, not asserted against a speed bar beyond
  // "bounded": a ~24MB tagless transcript, cold vs re-read after an append.
  {
    const f = path.join(dir, 'e16.jsonl');
    const block = filler(400);
    const fdw = fs.openSync(f, 'w'); for (let i = 0; i < 80; i++) fs.writeSync(fdw, block); fs.closeSync(fdw);
    smut.clearTitleMetaCache();
    let t0 = process.hrtime.bigint(); const m0 = readMeta(smut, f); const coldMs = Number(process.hrtime.bigint() - t0) / 1e6;
    fs.appendFileSync(f, turnLine(1)); const tt = new Date(Date.now() + 5000); fs.utimesSync(f, tt, tt);
    t0 = process.hrtime.bigint(); const m1 = readMeta(smut, f); const reMs = Number(process.hrtime.bigint() - t0) / 1e6;
    t0 = process.hrtime.bigint(); readMeta(smut, f); const hitMs = Number(process.hrtime.bigint() - t0) / 1e6;
    fs.appendFileSync(f, '{"type": "tag", "tag": "pinned"}\n'); const t3 = new Date(Date.now() + 9000); fs.utimesSync(f, t3, t3);
    const m2 = readMeta(smut, f);
    check('E16: a changed ~24MB tagless transcript is fully re-scanned and correct; an unchanged one is a cache hit (cost reported)',
      m0.tag === null && m1.tag === null && m2.pinned === true && reMs < 3000 && hitMs < 5,
      `size=${fs.statSync(f).size} cold=${coldMs.toFixed(1)}ms full-rescan-after-append=${reMs.toFixed(1)}ms unchanged-hit=${hitMs.toFixed(2)}ms then pinned=${m2.pinned}`);
  }

  // E12 — a GIANT single line (6MB, no newline inside) between the tags spans ~100
  // chunks; the tag after it must still be found, and the scan must stay bounded.
  {
    const big = JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(6 * 1024 * 1024) } }) + '\n';
    const f = mkFile('e12.jsonl', [compact('closed'), big, '{"type": "tag", "tag": "", "sessionId": "adv"}\n', big]);
    const t0 = process.hrtime.bigint();
    const m = cold(f);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    check('E12: a whitespace reopen between two 6MB single-line records is found (OPEN), scan bounded', m.closed === false && m.tag === null && ms < 3000,
      `closed=${m.closed} tag=${JSON.stringify(m.tag)} ms=${ms.toFixed(0)}`);
  }

  // E13 — truncation grading (cold AND warm-growing) of a realistic transcript whose
  // tag records are written in several formats, at every byte across each record
  // plus ~80 even cuts, against the independent forward-parse oracle.
  {
    const recs = [compact('closed'), '{"type": "tag", "tag": "triage"}\n', '{"tag":"","type":"tag"}\n', '{ "type":"t\\u0061g", "tag":"pinned" }\r\n', '{"type": "tag","tag": "closed"}\n'];
    const parts = []; recs.forEach((r, i) => { parts.push(filler(120 + i * 30)); parts.push(r); }); parts.push(filler(50));
    const base = Buffer.from(parts.join(''));
    const cuts = new Set();
    for (let c = 1; c < base.length; c += Math.floor(base.length / 80)) cuts.add(c);
    let at = 0;
    for (const r of recs) { const i = base.indexOf(Buffer.from(r), at); at = i + 1; for (let c = Math.max(1, i - 3); c <= i + r.length + 3 && c <= base.length; c++) cuts.add(c); }
    cuts.add(base.length);
    const sorted = [...cuts].sort((a, b) => a - b);
    const f = path.join(dir, 'e13.jsonl');
    let mism = 0, first = '';
    for (const c of sorted) { // cold
      fs.writeFileSync(f, base.subarray(0, c)); smut.clearTitleMetaCache();
      const got = readMeta(smut, f).tag, want = oracleTag(base.subarray(0, c));
      if (got !== want) { mism++; first ||= `cold cut=${c} got=${JSON.stringify(got)} want=${JSON.stringify(want)}`; }
    }
    smut.clearTitleMetaCache(); fs.writeFileSync(f, '');
    let k = 0;
    for (const c of sorted) { // warm: the file GROWS in place, cache never cleared
      fs.writeFileSync(f, base.subarray(0, c)); const t = new Date(Date.now() + (++k) * 1000); fs.utimesSync(f, t, t);
      const got = readMeta(smut, f).tag, want = oracleTag(base.subarray(0, c));
      if (got !== want) { mism++; first ||= `warm cut=${c} got=${JSON.stringify(got)} want=${JSON.stringify(want)}`; }
    }
    const preMiss = sorted.filter((c) => { fs.writeFileSync(f, base.subarray(0, c)); return preFixRound2Tag(f) !== oracleTag(base.subarray(0, c)); }).length;
    check(`E13 MUST-FAIL baseline: round-2 reader disagrees with the oracle at some truncations`, preMiss > 0, `${preMiss}/${sorted.length} cuts disagree`);
    check(`E13: reader matches the oracle at every truncation, cold and warm-growing (${sorted.length * 2} grades)`, mism === 0,
      mism ? `${mism} mismatches; first ${first}` : `all ${sorted.length * 2} agree`);
  }
}

/* =========================================================================
 * R. REAL ARTIFACT (read-only). The reader against the user's REAL transcript
 * store, compared to the forward-parse oracle: every file that holds a tag record
 * at all, plus the largest files and a spread of the rest; and truncation grading
 * of a COPY of a real tagged transcript. Nothing in the real store is written.
 * ========================================================================= */
async function realArtifactLayer() {
  console.log('\n===== R. real transcript store (read-only) =====');
  if (!fs.existsSync(REAL_STORE)) { check('R0: real store present', false, `missing ${REAL_STORE}`); return; }
  const smut = await import(path.join(ROOT, 'src', 'server', 'session-mutations.ts'));
  const files = [];
  for (const d of fs.readdirSync(REAL_STORE)) {
    let ents; try { ents = fs.readdirSync(path.join(REAL_STORE, d)); } catch { continue; }
    for (const f of ents) if (f.endsWith('.jsonl')) { const p = path.join(REAL_STORE, d, f); try { files.push({ p, size: fs.statSync(p).size }); } catch { /* raced */ } }
  }
  files.sort((a, b) => b.size - a.size);
  const pick = new Set(files.slice(0, 25).map((x) => x.p));
  for (let i = 0; i < files.length; i += Math.max(1, Math.floor(files.length / 250))) pick.add(files[i].p);
  // every file containing a tag record at all (cheap byte search just to SELECT
  // fixtures; the grade itself is the parsed oracle)
  const tagged = [];
  for (const { p, size } of files) {
    if (size > 64 * 1024 * 1024) continue;
    let b; try { b = fs.readFileSync(p); } catch { continue; }
    if (b.includes('"type":"tag"') || b.includes('"type": "tag"')) { pick.add(p); if (oracleTag(b) !== null) tagged.push(p); }
  }
  let mism = 0, first = '', n = 0;
  for (const p of pick) {
    let b; try { b = fs.readFileSync(p); } catch { continue; }
    smut.clearTitleMetaCache();
    const got = readMeta(smut, p).tag;
    const want = oracleTag(b);
    n++;
    if (got !== want) { mism++; first ||= `${path.basename(p)} got=${JSON.stringify(got)} want=${JSON.stringify(want)}`; }
  }
  check(`R1: reader == forward-parse oracle on ${n} REAL transcripts (${tagged.length} currently tagged)`, n > 0 && mism === 0, mism ? `${mism} mismatches; first ${first}` : `all ${n} agree`);
  if (!tagged.length) { check('R2: a real tagged transcript exists to truncate', false, 'none found — synthetic E13 is the only truncation grade'); return; }
  // Truncate a COPY of the smallest real tagged transcript around its last tag records.
  const src = tagged.map((p) => ({ p, s: fs.statSync(p).size })).sort((a, b) => a.s - b.s)[0].p;
  const real = fs.readFileSync(src);
  const f = path.join(TMP, 'real-trunc.jsonl');
  const cuts = new Set();
  let idx = real.length;
  for (let k = 0; k < 4; k++) { idx = real.lastIndexOf(Buffer.from('"tag"'), idx - 1); if (idx < 0) break; for (let c = Math.max(1, idx - 60); c <= Math.min(real.length, idx + 80); c++) cuts.add(c); }
  for (let c = 1; c < real.length; c += Math.max(1, Math.floor(real.length / 60))) cuts.add(c);
  let tm = 0, tfirst = '';
  for (const c of cuts) {
    fs.writeFileSync(f, real.subarray(0, c)); smut.clearTitleMetaCache();
    const got = readMeta(smut, f).tag, want = oracleTag(real.subarray(0, c));
    if (got !== want) { tm++; tfirst ||= `cut=${c} got=${JSON.stringify(got)} want=${JSON.stringify(want)}`; }
  }
  check(`R2: a COPY of a real tagged transcript (${real.length}B), truncated at ${cuts.size} points, matches the oracle`, tm === 0, tm ? `${tm} mismatches; first ${tfirst}` : `all ${cuts.size} agree`);
}


/* =========================================================================
 * RP. The prompt-watermark reader on the REAL store (read-only): it must agree
 * with a forward full-parse oracle on real transcripts, every real conversation
 * must yield a watermark (a canary: if a CLI update changes the prompt shape so
 * nothing is recognised, this goes red instead of sessions silently staying
 * closed), and a COPY of a real transcript truncated at many points — and grown
 * back append by append through the cache — must match the oracle at every cut.
 * ========================================================================= */
// A forward full-parse oracle for the contract (FEAT-168 round 8): identity is the
// record's uuid, else a hash of its full raw line plus how many byte-identical
// committed lines there are (its ordinal, since the matched line is the last input
// prompt). It must reproduce the production key EXACTLY (no sentinel), so a
// UUID-less / timestamp-colliding prompt is graded, not waved through.
function oraclePromptKey(smut, buf) {
  const text = buf.toString('utf8');
  const end = text.lastIndexOf('\n');
  if (end < 0) return null;
  const committed = text.slice(0, end).split('\n');
  let lastLine = null, lastUuid = null;
  for (const line of committed) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    if (smut.isInputPromptRecord(e)) { lastLine = line; lastUuid = typeof e.uuid === 'string' && e.uuid ? e.uuid : null; }
  }
  if (lastLine === null) return null;
  if (lastUuid) return `uuid:${lastUuid}`;
  let cnt = 0; for (const l of committed) if (l === lastLine) cnt++;
  return `h:${createHash('sha1').update(lastLine).digest('hex')}#${cnt}`;
}
const sameKey = (got, want) => got === want;

async function promptReaderLayer() {
  console.log('\n===== RP. the input-prompt watermark reader on the REAL store (read-only) =====');
  if (!fs.existsSync(REAL_STORE)) { check('RP0: real store present', false, `missing ${REAL_STORE}`); return; }
  const smut = await import(path.join(ROOT, 'src', 'server', 'session-mutations.ts'));
  const files = [];
  for (const d of fs.readdirSync(REAL_STORE)) {
    let ents; try { ents = fs.readdirSync(path.join(REAL_STORE, d)); } catch { continue; }
    for (const f of ents) if (f.endsWith('.jsonl')) { const p = path.join(REAL_STORE, d, f); try { const st = fs.statSync(p); files.push({ p, size: st.size, m: st.mtimeMs }); } catch { /* raced */ } }
  }
  const recent = files.slice().sort((a, b) => b.m - a.m).slice(0, 400);
  const biggest = files.slice().sort((a, b) => b.size - a.size).slice(0, 10).filter((x) => x.size < 96 * 1024 * 1024);
  const pick = new Map([...recent, ...biggest].map((x) => [x.p, x]));
  let n = 0, mism = 0, first = '', convo = 0, blind = 0, blindFirst = '';
  for (const { p } of pick.values()) {
    let b; try { b = fs.readFileSync(p); } catch { continue; }
    smut.clearPromptKeyCache();
    const got = smut.readLastPromptKey(p);
    const want = oraclePromptKey(smut, b);
    n++;
    if (!sameKey(got, want)) { mism++; first ||= `${path.basename(p)} got=${got} want=${want}`; }
    if (b.includes('"type":"assistant"')) { convo++; if (got === null) { blind++; blindFirst ||= path.basename(p); } }
  }
  check(`RP1: reader == forward-parse oracle on ${n} REAL transcripts (the ${recent.length} newest + the largest)`, n > 0 && mism === 0, mism ? `${mism} mismatches; first ${first}` : `all ${n} agree`);
  check(`RP2 canary: every real conversation (${convo} with an assistant reply) yields an input-prompt watermark`, convo > 0 && blind === 0, blind ? `${blind} with NO recognised prompt; first ${blindFirst}` : `all ${convo}`);
  // Truncation + growth grading on a COPY of a real transcript with many prompts.
  const cands = recent.filter((x) => x.size > 200 * 1024 && x.size < 24 * 1024 * 1024);
  let src = null, srcBuf = null;
  for (const c of cands) { const b = fs.readFileSync(c.p); const k = (b.toString('utf8').match(/"promptSource":"(sdk|typed)"/g) ?? []).length; if (k >= 5) { src = c.p; srcBuf = b; break; } }
  if (!src) { check('RP3: a real multi-prompt transcript exists to truncate', false, 'none found'); return; }
  const f = path.join(TMP, 'rp-trunc.jsonl');
  const cuts = new Set();
  const needle = Buffer.from('"promptSource":"');
  let idx = srcBuf.length;
  for (let k = 0; k < 6; k++) {
    idx = srcBuf.lastIndexOf(needle, idx - 1); if (idx < 0) break;
    const ls = srcBuf.lastIndexOf(0x0a, idx) + 1, le = srcBuf.indexOf(0x0a, idx);
    for (const c of [ls - 1, ls, ls + 1, idx, le - 1, le, le + 1, le + 2]) if (c > 0 && c <= srcBuf.length) cuts.add(c);
    for (let c = Math.max(1, ls - 40); c <= Math.min(srcBuf.length, ls + 40); c += 7) cuts.add(c);
  }
  for (let c = 1; c < srcBuf.length; c += Math.max(1, Math.floor(srcBuf.length / 150))) cuts.add(c);
  cuts.add(srcBuf.length);
  let tm = 0, tfirst = '';
  for (const c of cuts) {
    fs.writeFileSync(f, srcBuf.subarray(0, c)); smut.clearPromptKeyCache();
    const got = smut.readLastPromptKey(f), want = oraclePromptKey(smut, srcBuf.subarray(0, c));
    if (!sameKey(got, want)) { tm++; tfirst ||= `cut=${c} got=${got} want=${want}`; }
  }
  check(`RP3: a COPY of a real transcript (${srcBuf.length}B), truncated COLD at ${cuts.size} points (dense around its last prompt records), matches the oracle`, tm === 0, tm ? `${tm} mismatches; first ${tfirst}` : `all ${cuts.size} agree`);
  // Warm: grow the copy append by append (a writer mid-flight), reading through the cache each time.
  const sorted = [...cuts].sort((a, b) => a - b);
  fs.writeFileSync(f, srcBuf.subarray(0, sorted[0])); smut.clearPromptKeyCache();
  let wm = 0, wfirst = '', prev = sorted[0];
  for (const c of sorted.slice(1)) {
    fs.appendFileSync(f, srcBuf.subarray(prev, c)); prev = c;
    const got = smut.readLastPromptKey(f), want = oraclePromptKey(smut, srcBuf.subarray(0, c));
    if (!sameKey(got, want)) { wm++; wfirst ||= `cut=${c} got=${got} want=${want}`; }
  }
  check(`RP4: the same copy GROWN append by append through the warm cache (${sorted.length - 1} steps) matches the oracle at every step`, wm === 0, wm ? `${wm} mismatches; first ${wfirst}` : `all ${sorted.length - 1} agree`);
  // Cost row (not a gate): a cold read of the largest real transcript.
  const big = biggest[0];
  if (big) { smut.clearPromptKeyCache(); const t0 = performance.now(); smut.readLastPromptKey(big.p); const ms = performance.now() - t0; check(`RP5 (cost row): cold watermark read of the largest real transcript (${(big.size / 1048576).toFixed(1)} MB)`, true, `${ms.toFixed(1)} ms`); }
}

/* =========================================================================
 * RB. the input-prompt watermark reader on a UUID-less prompt whose RAW line
 * carries an INVALID UTF-8 byte (FEAT-168 round 9, the round-8 clean-room break
 * adv 5c35fc4497f6). The contract: identity = sha1(RAW line bytes)#<count of
 * byte-identical committed lines>. The round-8 reader keyed on the UTF-8-DECODED
 * string — so (a) two distinct uuid-less prompts differing only in a non-UTF-8
 * byte both decode to the same text and COLLIDE to one key, and (b) its count
 * re-encodes the decoded text (`Buffer.from(decoded,'utf8')`), which never
 * byte-matches a non-UTF-8 line, so the count is 0 and a byte-identical repeat
 * never bumps the ordinal. Either way a new message cannot re-open a closed
 * session. SYNTHETIC: no real CLI prompt is uuid-less today (round-8 survey:
 * all 6,632 real input prompts carry a uuid) — this grades the contract the
 * dispatch states, against the exact adversarial shape that broke it.
 *
 * The RP-layer oracle (and the round-8 reader) both decode to a string, so
 * neither could catch this. Here the oracle operates on RAW Buffers.
 * ========================================================================= */
// Raw-byte forward-parse oracle: hash + count on the RAW line bytes.
function oraclePromptKeyRaw(smut, buf) {
  const end = buf.lastIndexOf(0x0a);
  if (end < 0) return null;
  const region = buf.subarray(0, end); // committed region (drops the final newline + any tail)
  const lines = [];
  let s = 0, nl;
  while ((nl = region.indexOf(0x0a, s)) !== -1) { lines.push(region.subarray(s, nl)); s = nl + 1; }
  lines.push(region.subarray(s));
  let lastBuf = null, lastUuid = null;
  for (const lb of lines) {
    let e; try { e = JSON.parse(lb.toString('utf8')); } catch { continue; }
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    if (smut.isInputPromptRecord(e)) { lastBuf = lb; lastUuid = typeof e.uuid === 'string' && e.uuid ? e.uuid : null; }
  }
  if (lastBuf === null) return null;
  if (lastUuid) return `uuid:${lastUuid}`;
  let cnt = 0; for (const lb of lines) if (lb.equals(lastBuf)) cnt++;
  return `h:${createHash('sha1').update(lastBuf).digest('hex')}#${cnt}`;
}
// Faithful reproduction of the ROUND-8 reader's uuid-less key: hash the DECODED
// string and count by re-encoding it (so a non-UTF-8 line never matches -> #0).
function round8PromptKey(smut, buf) {
  const end = buf.lastIndexOf(0x0a);
  if (end < 0) return null;
  const region = buf.subarray(0, end);
  const rawLines = [];
  let s = 0, nl;
  while ((nl = region.indexOf(0x0a, s)) !== -1) { rawLines.push(region.subarray(s, nl)); s = nl + 1; }
  rawLines.push(region.subarray(s));
  let lastStr = null, lastUuid = null;
  for (const lb of rawLines) {
    const str = lb.toString('utf8');
    let e; try { e = JSON.parse(str); } catch { continue; }
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    if (smut.isInputPromptRecord(e)) { lastStr = str; lastUuid = typeof e.uuid === 'string' && e.uuid ? e.uuid : null; }
  }
  if (lastStr === null) return null;
  if (lastUuid) return `uuid:${lastUuid}`;
  const target = Buffer.from(lastStr, 'utf8');
  let cnt = 0; for (const lb of rawLines) if (lb.equals(target)) cnt++;
  return `h:${createHash('sha1').update(target).digest('hex')}#${cnt}`;
}

async function rawBytePromptReaderLayer() {
  console.log('\n===== RB. uuid-less prompt with a non-UTF-8 byte: key on RAW bytes (round 9) =====');
  const smut = await import(path.join(ROOT, 'src', 'server', 'session-mutations.ts'));
  // A realistic-ish transcript prefix: a prior uuid'd prompt + an assistant reply,
  // then end with a UUID-LESS prompt whose content carries one invalid UTF-8 byte.
  const prior = Buffer.from(JSON.stringify({ type: 'user', promptSource: 'typed', uuid: 'aaaaaaaa-0000-4000-8000-000000000001', message: { role: 'user', content: 'hello' } }) + '\n'
    + JSON.stringify({ type: 'assistant', uuid: 'bbbbbbbb-0000-4000-8000-000000000002', message: { role: 'assistant', content: 'hi' } }) + '\n');
  const mkPrompt = (byte) => Buffer.concat([
    Buffer.from('{"type":"user","promptSource":"typed","message":{"role":"user","content":"x'),
    Buffer.from([byte]),
    Buffer.from('y"}}\n'),
  ]);
  const write = (name, ...bufs) => { const p = path.join(TMP, name); fs.writeFileSync(p, Buffer.concat(bufs)); return p; };

  // Sanity: the non-UTF-8 prompt line still classifies as an input prompt, and
  // its decoded text re-encodes to DIFFERENT bytes (the premise of the break).
  const lineFF = mkPrompt(0xff).subarray(0, -1); // drop newline
  const decodedRedecoded = Buffer.from(lineFF.toString('utf8'), 'utf8');
  check('RB0: the non-UTF-8 prompt line classifies as an input prompt and is lossy on decode',
    smut.isInputPromptRecord(JSON.parse(lineFF.toString('utf8'))) === true && !decodedRedecoded.equals(lineFF),
    `classified=${smut.isInputPromptRecord(JSON.parse(lineFF.toString('utf8')))} lossy=${!decodedRedecoded.equals(lineFF)}`);

  // Case A (identity rule 2): two prompts differing ONLY in the invalid byte.
  const fA = write('rb-a-ff.jsonl', prior, mkPrompt(0xff));
  const fB = write('rb-b-fe.jsonl', prior, mkPrompt(0xfe));
  smut.clearPromptKeyCache(); const kA = smut.readLastPromptKey(fA);
  smut.clearPromptKeyCache(); const kB = smut.readLastPromptKey(fB);
  const bufA = fs.readFileSync(fA), bufB = fs.readFileSync(fB);
  // MUST-FAIL baseline: the round-8 decoded-string key COLLIDES these distinct prompts.
  check('RB-A MUST-FAIL baseline: round-8 decoded-string key collides two prompts differing only in a non-UTF-8 byte',
    round8PromptKey(smut, bufA) === round8PromptKey(smut, bufB), `r8 A=${round8PromptKey(smut, bufA)} B=${round8PromptKey(smut, bufB)}`);
  check('RB-A: distinct uuid-less prompts (differ only in a non-UTF-8 byte) get DISTINCT keys',
    kA !== null && kB !== null && kA !== kB, `kA=${kA} kB=${kB}`);
  check('RB-A oracle: reader matches the RAW-byte oracle for both', kA === oraclePromptKeyRaw(smut, bufA) && kB === oraclePromptKeyRaw(smut, bufB),
    `A got=${kA} want=${oraclePromptKeyRaw(smut, bufA)} | B got=${kB} want=${oraclePromptKeyRaw(smut, bufB)}`);

  // Case B ("a new message re-opens"): the SAME non-UTF-8 prompt appended again
  // must bump the ordinal (#1 -> #2), i.e. produce a new key -> reopen.
  const f1 = write('rb-one.jsonl', prior, mkPrompt(0xff));
  const f2 = write('rb-two.jsonl', prior, mkPrompt(0xff), mkPrompt(0xff));
  smut.clearPromptKeyCache(); const k1 = smut.readLastPromptKey(f1);
  smut.clearPromptKeyCache(); const k2 = smut.readLastPromptKey(f2);
  const buf1 = fs.readFileSync(f1), buf2 = fs.readFileSync(f2);
  // MUST-FAIL baseline: round-8 count re-encodes -> #0 for both -> same key (no reopen).
  check('RB-B MUST-FAIL baseline: round-8 count re-encodes the decoded text to 0, so a byte-identical repeat keeps the same key',
    /#0$/.test(round8PromptKey(smut, buf1)) && round8PromptKey(smut, buf1) === round8PromptKey(smut, buf2),
    `r8 one=${round8PromptKey(smut, buf1)} two=${round8PromptKey(smut, buf2)}`);
  check('RB-B: a byte-identical non-UTF-8 prompt re-appended yields a NEW key (so the session re-opens)',
    k1 !== null && k2 !== null && k1 !== k2 && /#1$/.test(k1) && /#2$/.test(k2), `one=${k1} two=${k2}`);
  check('RB-B oracle: reader matches the RAW-byte oracle for both', k1 === oraclePromptKeyRaw(smut, buf1) && k2 === oraclePromptKeyRaw(smut, buf2),
    `one got=${k1} want=${oraclePromptKeyRaw(smut, buf1)} | two got=${k2} want=${oraclePromptKeyRaw(smut, buf2)}`);

  // Case C: byte-cut truncation of the non-UTF-8 fixture — cold, every cut agrees
  // with the raw-byte oracle (a mid-write of a non-UTF-8 prompt must not mis-key).
  const fc = path.join(TMP, 'rb-cut.jsonl');
  let cm = 0, cfirst = '';
  for (let c = 1; c <= buf2.length; c++) {
    fs.writeFileSync(fc, buf2.subarray(0, c)); smut.clearPromptKeyCache();
    const got = smut.readLastPromptKey(fc), want = oraclePromptKeyRaw(smut, buf2.subarray(0, c));
    if (got !== want) { cm++; cfirst ||= `cut=${c} got=${got} want=${want}`; }
  }
  check(`RB-C: ${buf2.length} byte-cuts of the non-UTF-8 fixture match the RAW-byte oracle cold`, cm === 0, cm ? `${cm} mismatches; first ${cfirst}` : `all ${buf2.length} agree`);
}

/* =========================================================================
 * E2E ROUTES (round 6). Every Orchard route a prompt can take into a CLOSED
 * session, driven on an isolated scratch server (scripts/lib/bug-187-harness:
 * own CLAUDE_STATION_DATA + transcript store, free port) with the scripted CLI,
 * which RECORDS each prompt it takes into the session's transcript in the
 * modern CLI shape (FAKE_TRANSCRIPT_SHAPE=modern) — as the real CLI does. Each
 * route must leave the session reading OPEN afterwards, with no per-route code.
 * And the things that are NOT a prompt into this session must leave it closed.
 *
 * FEAT168_SERVER_TREE=<dir> boots every E2E server from another tree (the
 * reconstructed round-5 tree for the must-FAIL run recorded in the ticket).
 * ========================================================================= */
const SERVER_TREE = process.env.FEAT168_SERVER_TREE || ROOT;
const encOf = (w) => w.work.replace(/[^a-zA-Z0-9]/g, '-');
const fakeEnv = (w, sdkId) => ({ ...(sdkId ? { FAKE_SDK_ID: sdkId } : {}), FAKE_TRANSCRIPT_DIR: path.join(w.store, encOf(w)), FAKE_TRANSCRIPT_SHAPE: 'modern' });
function apiOf(srv) {
  const api = async (method, p, body) => { const r = await fetch(`http://127.0.0.1:${srv.port}${p}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) }); let j = {}; try { j = await r.json(); } catch { /* */ } return { status: r.status, json: j }; };
  return api;
}
const rowIn = async (api, pid, id) => ((await api('GET', `/api/projects/${pid}/sessions`)).json.sessions ?? []).find((s) => s.sessionId === id);
const userRecordsWith = (file, marker) => { try { return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.includes(marker) && l.includes('"type":"user"')).length; } catch { return 0; } };

async function wsLayer() {
  console.log('\n===== W. route: ws `send` into a LIVE closed session =====');
  const H = await import('./lib/bug-187-harness.mjs');
  const w = H.makeWorld('feat168w', { tree: SERVER_TREE });
  const sdkId = 'eeeeeeee-1680-4168-8168-000000000001';
  const other = 'eeeeeeee-1680-4168-8168-000000000002'; // a second closed session nobody sends to
  try {
    const srv = await H.bootServer(w, fakeEnv(w, sdkId));
    const pid = await H.registerProject(srv, w);
    const api = apiOf(srv);
    const tFile = H.writeSyntheticTranscript(w, sdkId, ['first turn', 'second turn']);
    fs.appendFileSync(tFile, JSON.stringify({ type: 'tag', tag: 'external-triage', sessionId: sdkId }) + '\n');
    H.writeSyntheticTranscript(w, other, ['untouched']);

    const s = await H.startFakeSession(srv, w, pid, 'seed turn for FEAT-168', { resumeSessionId: sdkId });
    const init = await H.waitEv(s.c, (e) => e.t === 'session-init', 20_000);
    check('W0: the scripted session is live on the real server (session-init carries our sdk id)', init?.sessionId === sdkId, `init=${init?.sessionId}`);
    await H.waitEv(s.c, (e) => e.t === 'result' || e.t === 'turn-end' || e.t === 'idle', 15_000);

    const h0 = sha(tFile);
    let r = await api('POST', `/api/sessions/${sdkId}/close`);
    await api('POST', `/api/sessions/${other}/close`);
    check('W1: closing the LIVE session is allowed and recorded (closed=true); closing wrote nothing to the transcript',
      r.status === 200 && r.json.session?.closed === true && sha(tFile) === h0, `status=${r.status} closed=${r.json.session?.closed} same=${sha(tFile) === h0} code=${r.json.code ?? ''}`);
    await H.sleep(500);
    check('W2: closing did not stop the runtime (the scripted CLI pid is alive)', H.pidAlive(s.cli), `cli=${s.cli} alive=${H.pidAlive(s.cli)}`);
    // The running session's OWN continuing output (the CLI appending its reply / a tool turn) must not reopen it.
    fs.appendFileSync(tFile, JSON.stringify({ type: 'assistant', uuid: `a-cont-${Date.now()}`, sessionId: sdkId, cwd: w.work, timestamp: new Date().toISOString(), version: '2.1.286', message: { role: 'assistant', content: [{ type: 'text', text: 'still working…' }] } }) + '\n'
      + JSON.stringify({ type: 'user', uuid: `t-cont-${Date.now()}`, sessionId: sdkId, cwd: w.work, timestamp: new Date().toISOString(), version: '2.1.286', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } }) + '\n');
    check('W2b: the running session\'s own continuing output (assistant + tool_result records) leaves it CLOSED (close sticks on a running session)',
      (await rowIn(api, pid, sdkId))?.closed === true, `closed=${(await rowIn(api, pid, sdkId))?.closed}`);

    const marker = `feat168-${Date.now().toString(36)}`;
    s.c.send({ type: 'send', prompt: `${marker} new work for a closed session`, sendId: 'feat168-send' });
    const delivered = await H.waitFor(() => H.fakeTap(w, s.cli).some((x) => x.m?.type === 'user' && JSON.stringify(x.m.message ?? '').includes(marker)), 20_000);
    const recorded = await H.waitFor(() => (userRecordsWith(tFile, marker) ? true : null), 10_000);
    const row = await rowIn(api, pid, sdkId);
    check('W3: the real ws send DELIVERED the message to the runtime, which recorded it in the transcript', !!delivered && !!recorded, `delivered=${!!delivered} recorded=${!!recorded}`);
    check('W4: the session now reads OPEN (list closed=false) — with no reopen code on the send path', row?.closed === false, `closed=${row?.closed}`);
    check('W5: its FOREIGN tag is intact (close/reopen never touch the tag)', row?.tag === 'external-triage', `tag=${row?.tag}`);
    check('W6: specificity — the OTHER closed session (no message sent) is still closed', (await rowIn(api, pid, other))?.closed === true, `other.closed=${(await rowIn(api, pid, other))?.closed}`);
    check('W7: the runtime is still alive after the auto-reopen', H.pidAlive(s.cli), `alive=${H.pidAlive(s.cli)}`);
    s.c.close();
  } catch (err) {
    check('W: layer ran to completion', false, String(err?.stack ?? err).slice(0, 600));
  } finally {
    await H.cleanupWorld(w);
  }
}

async function startResumeLayer() {
  console.log('\n===== SR. route: ws `start` + resume of a CLOSED, NON-LIVE session (the round-4 break) =====');
  const H = await import('./lib/bug-187-harness.mjs');
  const w = H.makeWorld('feat168sr', { tree: SERVER_TREE });
  const srId = 'eeeeeeee-1680-4168-8168-0000000000a1';
  const other = 'eeeeeeee-1680-4168-8168-0000000000a2';
  try {
    const srv = await H.bootServer(w, fakeEnv(w, srId));
    const pid = await H.registerProject(srv, w);
    const api = apiOf(srv);
    const tFile = H.writeSyntheticTranscript(w, srId, ['earlier turn one', 'earlier turn two']);
    fs.appendFileSync(tFile, JSON.stringify({ type: 'tag', tag: 'external-triage', sessionId: srId }) + '\n');
    H.writeSyntheticTranscript(w, other, ['untouched']);
    const rc = await api('POST', `/api/sessions/${srId}/close`);
    await api('POST', `/api/sessions/${other}/close`);
    check('SR0: a NON-LIVE session is closed via /close (closed=true), no broker exists', rc.status === 200 && rc.json.session?.closed === true && H.hostRecords(w).length === 0, `status=${rc.status} closed=${rc.json.session?.closed} hosts=${H.hostRecords(w).length}`);
    const marker = `feat168sr-${Date.now().toString(36)}`;
    const s = await H.startFakeSession(srv, w, pid, `${marker} resuming a closed session`, { resumeSessionId: srId });
    const init = await H.waitEv(s.c, (e) => e.t === 'session-init', 20_000);
    check('SR1: the ws start/resume brought the closed session live (session-init carries our id)', init?.sessionId === srId, `init=${init?.sessionId}`);
    const recorded = await H.waitFor(() => (userRecordsWith(tFile, marker) ? true : null), 20_000);
    check('SR2: the resumed message was DELIVERED and recorded in the transcript', !!recorded, `recorded=${!!recorded}`);
    const row = await rowIn(api, pid, srId);
    check('SR3: the session now reads OPEN (list closed=false)', row?.closed === false, `closed=${row?.closed}`);
    check('SR4: its foreign tag is intact', row?.tag === 'external-triage', `tag=${row?.tag}`);
    check('SR5: specificity — the OTHER closed non-live session stays closed', (await rowIn(api, pid, other))?.closed === true, `other.closed=${(await rowIn(api, pid, other))?.closed}`);
    s.c.close();
  } catch (err) {
    check('SR: layer ran to completion', false, String(err?.stack ?? err).slice(0, 600));
  } finally {
    await H.cleanupWorld(w);
  }
}

/* G. route: the adopt-gated broker after a restart (the round-5 break — dispatch anthropic run
 * 08654040, adv 6a10f1fa2c4b, ported here). A broker from a prior server that DECLINES reclaim
 * leaves the session responder-only (BUG-191); a prompt then goes sendGated() -> broker.deliver(),
 * which no round-5 hook covered. Both shapes: a reattach `start` carrying the prompt, and a `send`
 * on an attached socket. MUST-FAIL on the round-5 tree. */
async function adoptGatedLayer() {
  console.log('\n===== G. route: sendGated -> broker.deliver on a responder-only adopt-gated broker after restart (the round-5 break) =====');
  const H = await import('./lib/bug-187-harness.mjs');
  const worlds = [];
  const liveSession = async (srv, station) => ((await H.health(srv))?.sessions ?? []).find((x) => x.stationSessionId === station) ?? null;
  const decliningBrokerScript = (w) => {
    const dir = path.join(w.base, 'declining-host'); fs.mkdirSync(dir, { recursive: true });
    for (const f of ['session-host.mjs', 'request-floor.mjs', 'path-env.mjs']) fs.copyFileSync(path.join(SERVER_TREE, 'src', 'server', f), path.join(dir, f));
    const p = path.join(dir, 'session-host.mjs'); const s = fs.readFileSync(p, 'utf8');
    const anchor = 'else { reclaim(); reply = { ok: true }; }';
    if (s.split(anchor).length !== 2) throw new Error('declining-broker anchor not found');
    fs.writeFileSync(p, s.replace(anchor, "else { reply = { ok: false, reason: 'declined-by-test-variant' }; }"));
    return p;
  };
  try {
    for (const mode of ['reattach-start', 'attached-send']) {
      const w = H.makeWorld(`f168g-${mode}`, { tree: SERVER_TREE }); worlds.push(w);
      const sdk = `eeeeeeee-1680-4168-8168-0000000000${mode === 'reattach-start' ? 'c1' : 'c2'}`;
      const srv0 = await H.bootServer(w); const port = srv0.port; const pid = await H.registerProject(srv0, w); await H.stopServer(srv0);
      const station = `f168g-${mode}-${Date.now().toString(36)}`;
      const tFile = H.writeSyntheticTranscript(w, sdk, ['earlier: work', 'earlier: more']);
      const b = H.spawnBrokerDirect(w, { hostScript: decliningBrokerScript(w), command: process.execPath, args: [H.FAKE_CLI], stationSessionId: station, env: { CLAUDE_STATION_HOST_ABANDON_MS: '600000', ...fakeEnv(w, sdk) } });
      const st = await H.waitFor(() => { const r = H.readJson(b.statusPath); return r?.claudePid ? r : null; }, 8_000);
      const orig = await H.rawClient(b.sock);
      orig.write({ type: 'control_request', request_id: 'orig-init', request: { subtype: 'initialize', hooks: {} } });
      await H.sleep(300);
      H.fakeCmd(w, st.claudePid, { op: 'lane_start', id: 'LD' });
      await H.waitFor(() => H.readJson(b.statusPath)?.sdkSessionId ?? null, 8_000);
      await H.sleep(500); orig.close(); await H.sleep(300);
      const srv = await H.bootServer(w, {}, { port });
      const api = apiOf(srv);
      const x = await H.waitFor(async () => { const s = await liveSession(srv, station); return s && s.adoptState && s.adoptState !== 'pending' ? s : null; }, 20_000);
      await H.waitFor(() => (H.readJson(b.statusPath)?.midTurn === false ? true : null), 5_000);
      const rc = await api('POST', `/api/sessions/${sdk}/close`);
      check(`G ${mode} PRE: the session is responder-only (adopt-gated) after the restart, and CLOSED`, x?.adoptState === 'responder-only' && rc.json.session?.closed === true, { adopt: x?.adoptState, close: rc.status, closed: rc.json.session?.closed });
      const marker = `F168G-${mode}-${Date.now()}`;
      const c = await H.openWs(srv);
      if (mode === 'reattach-start') {
        c.send({ type: 'start', projectId: pid, resumeSessionId: sdk, prompt: `${marker} new work` });
      } else {
        c.send({ type: 'start', projectId: pid, resumeSessionId: sdk, prompt: '' });
        await H.waitFor(() => c.events.find((e) => (e.t === 'ack' && e.of === 'start') || e.t === 'error'), 15_000);
        c.send({ type: 'send', prompt: `${marker} new work`, sendId: 'f168g' });
      }
      const got = await H.waitFor(() => (userRecordsWith(tFile, marker) ? true : null), 15_000);
      await H.sleep(800);
      const r = await rowIn(api, pid, sdk);
      check(`G ${mode}: the prompt was DELIVERED through the gated broker and recorded in the transcript`, !!got, { recorded: !!got });
      check(`G ${mode} (MUST-FAIL on round 5): the delivered prompt leaves the session reading OPEN`, !!got && r?.closed === false, { listClosed: r?.closed });
      c.close();
      H.fakeCmd(w, st.claudePid, { op: 'lane_end', id: 'LD' });
    }
  } catch (err) {
    check('G: layer ran to completion', false, String(err?.stack ?? err).slice(0, 600));
  } finally {
    for (const w of worlds) await H.cleanupWorld(w);
  }
}

/* O. route: the OUTBOX (BUG-217) — a message queued with no tab open, delivered by the server itself
 * (its resume route) once the session can take a turn. */
async function outboxLayer() {
  console.log('\n===== O. route: the server-owned outbox delivers into a CLOSED, idle session (no tab) =====');
  const H = await import('./lib/bug-187-harness.mjs');
  const w = H.makeWorld('feat168o', { tree: SERVER_TREE });
  const sdk = 'eeeeeeee-1680-4168-8168-0000000000d1';
  try {
    const srv = await H.bootServer(w, fakeEnv(w, sdk));
    const pid = await H.registerProject(srv, w);
    const api = apiOf(srv);
    const tFile = H.writeSyntheticTranscript(w, sdk, ['earlier: one', 'earlier: two']);
    // Warm up (the boot runtime check), then let the bridge and broker go: the "nothing to reattach to" state.
    const s = await H.startFakeSession(srv, w, pid, 'warm-up', { resumeSessionId: sdk });
    await H.waitEv(s.c, (e) => e.t === 'turn-end', 20_000);
    s.c.close();
    const gone = await H.waitFor(async () => {
      const r = await api('GET', '/api/sessions');
      const held = (Array.isArray(r.json) ? r.json : (r.json.sessions ?? [])).some((x) => x.sdkSessionId === sdk);
      return !held && !H.hostRecords(w).some((h) => h.sdkSessionId === sdk && H.pidAlive(h.hostPid)) ? true : null;
    }, 60_000, 400);
    const age = (Date.now() - 120_000) / 1000; fs.utimesSync(tFile, age, age);
    const rc = await api('POST', `/api/sessions/${sdk}/close`);
    check('O0: the session is idle (no bridge, no broker) and CLOSED', !!gone && rc.json.session?.closed === true, { idle: !!gone, closed: rc.json.session?.closed });
    const marker = `F168O-${Date.now()}`;
    const q = await api('POST', '/api/outbox', { session: sdk, dir: encOf(w), project: pid, nonce: `n-f168-${Date.now()}`, text: `${marker} queued for a closed session` });
    const got = await H.waitFor(() => (userRecordsWith(tFile, marker) ? true : null), 45_000, 300);
    const r = await rowIn(api, pid, sdk);
    check('O1: the outbox row was accepted and the server delivered it by itself (recorded in the transcript)', q.status === 201 && !!got, { queued: q.status, recorded: !!got });
    check('O2: the session now reads OPEN', !!got && r?.closed === false, { closed: r?.closed });
  } catch (err) {
    check('O: layer ran to completion', false, String(err?.stack ?? err).slice(0, 600));
  } finally {
    await H.cleanupWorld(w);
  }
}

/* S. route: delivery into a SURVIVING broker (survivor-delivery.ts deliverIntoSurvivor — the
 * primitive the ws `start` survivor-inject and the outbox survivor route both call), driven
 * directly against a real broker (this tree's session-host.mjs) running the scripted CLI. */
async function survivorLayer() {
  console.log('\n===== S. route: deliverIntoSurvivor into a surviving broker =====');
  const H = await import('./lib/bug-187-harness.mjs');
  const sc = await import(path.join(ROOT, 'src', 'server', 'session-closed.ts'));
  const sd = await import(path.join(SERVER_TREE, 'src', 'server', 'survivor-delivery.ts'));
  const w = H.makeWorld('feat168s', { tree: SERVER_TREE });
  const sdk = 'eeeeeeee-1680-4168-8168-0000000000e1';
  try {
    const tFile = H.writeSyntheticTranscript(w, sdk, ['earlier: survivor work']);
    const b = H.spawnBrokerDirect(w, { hostScript: path.join(SERVER_TREE, 'src', 'server', 'session-host.mjs'), command: process.execPath, args: [H.FAKE_CLI], stationSessionId: 'f168s', env: { CLAUDE_STATION_HOST_ABANDON_MS: '600000', ...fakeEnv(w, sdk) } });
    const st = await H.waitFor(() => { const r = H.readJson(b.statusPath); return r?.claudePid ? r : null; }, 8_000);
    sc.setSessionClosed({ sessionId: sdk, filePath: tFile }, true);
    const before = sc.isSessionClosed(sdk, tFile);
    const marker = `F168S-${Date.now()}`;
    const handle = await sd.deliverIntoSurvivor({ survivor: { ...H.readJson(b.statusPath) }, sdkSessionId: sdk, prompt: `${marker} into the survivor`, client: () => {} });
    const got = await H.waitFor(() => (userRecordsWith(tFile, marker) ? true : null), 10_000);
    check('S1: the survivor accepted the delivery and the CLI recorded it', !!handle && handle !== 'uncertain' && !!got, { handle: handle ? (handle === 'uncertain' ? 'uncertain' : 'established') : null, recorded: !!got });
    check('S2: the session read CLOSED before and OPEN after (no reopen code in survivor-delivery)', before === true && sc.isSessionClosed(sdk, tFile) === false, { before, after: sc.isSessionClosed(sdk, tFile) });
    try { handle?.finish?.('test done'); } catch { /* */ }
    void st;
  } catch (err) {
    check('S: layer ran to completion', false, String(err?.stack ?? err).slice(0, 600));
  } finally {
    await H.cleanupWorld(w);
  }
}

/* F + N. NOT a prompt into this session: a FORK of it (the round-5 constructor hook reopened
 * the SOURCE — MUST-FAIL on round 5), a FRESH session in the same project, viewing it, renaming
 * it, pinning it. And T: a prompt typed into it OUTSIDE Orchard (`claude --resume` in a terminal
 * — the CLI records it; no Orchard route at all) DOES reopen it (MUST-FAIL on round 5). */
async function notAPromptLayer() {
  console.log('\n===== F/N/T. fork, fresh session, view do NOT reopen (rename/pin: layer A); a terminal-typed prompt DOES =====');
  const H = await import('./lib/bug-187-harness.mjs');
  const w = H.makeWorld('feat168f', { tree: SERVER_TREE });
  const src = 'eeeeeeee-1680-4168-8168-0000000000f1';
  const forkId = 'eeeeeeee-1680-4168-8168-0000000000f2'; // the id the CLI gives the fork
  try {
    const srv = await H.bootServer(w, fakeEnv(w, forkId));
    const pid = await H.registerProject(srv, w);
    const api = apiOf(srv);
    const sFile = H.writeSyntheticTranscript(w, src, ['source: the work', 'source: more work']);
    const age = (Date.now() - 120_000) / 1000; fs.utimesSync(sFile, age, age);
    const rc = await api('POST', `/api/sessions/${src}/close`);
    check('F0: the source session is CLOSED', rc.json.session?.closed === true, { closed: rc.json.session?.closed });
    const hs = sha(sFile);
    const marker = `F168F-${Date.now()}`;
    const s = await H.startFakeSession(srv, w, pid, `${marker} continue in a fork`, { resumeSessionId: src, fork: true });
    const init = await H.waitEv(s.c, (e) => e.t === 'session-init', 20_000);
    const fFile = path.join(w.store, encOf(w), `${forkId}.jsonl`);
    const got = await H.waitFor(() => (userRecordsWith(fFile, marker) ? true : null), 15_000);
    await H.waitEv(s.c, (e) => e.t === 'turn-end', 15_000);
    await H.sleep(500);
    check('F1: the fork ran under its OWN id and recorded the prompt in its own file; the source file is byte-identical', init?.sessionId === forkId && !!got && sha(sFile) === hs, { init: init?.sessionId, recorded: !!got, sourceSame: sha(sFile) === hs });
    const rs = await rowIn(api, pid, src), rf = await rowIn(api, pid, forkId);
    check('F2 (MUST-FAIL on round 5): forking a closed session leaves the SOURCE closed', rs?.closed === true, { sourceClosed: rs?.closed });
    check('F3: the fork itself is OPEN', rf && rf.closed === false, { forkClosed: rf?.closed, listed: !!rf });
    s.c.close();
    // Each row below starts from a freshly CLOSED source, so it cannot lean on F2's outcome.
    const reclose = async () => (await api('POST', `/api/sessions/${src}/close`)).json.session?.closed === true;
    await reclose();
    // A FRESH session (no resume) in the same project: the fake records under the fork id again; the source is untouched.
    const s2 = await H.startFakeSession(srv, w, pid, `${marker} a brand-new session`);
    await H.waitEv(s2.c, (e) => e.t === 'turn-end', 20_000);
    s2.c.close();
    check('N1: starting a FRESH session in the project leaves the closed source closed', (await rowIn(api, pid, src))?.closed === true, { closed: (await rowIn(api, pid, src))?.closed });
    // View: the transcript routes Orchard serves when the session is opened.
    const v1 = await api('GET', `/api/transcript/${encodeURIComponent(encOf(w))}/${src}`);
    const v2 = await api('GET', `/api/transcript/${encodeURIComponent(encOf(w))}/${src}?tail=50&tools=1`);
    check('N2: VIEWING it (the transcript routes the session view loads, incl. the FEAT-144 mirror-on-read) leaves it closed and its file untouched',
      v1.status === 200 && v2.status === 200 && (await rowIn(api, pid, src))?.closed === true && sha(sFile) === hs, { statuses: [v1.status, v2.status], closed: (await rowIn(api, pid, src))?.closed, same: sha(sFile) === hs });
    // (Rename and pin need the SDK's own CLAUDE_CONFIG_DIR, which this harness world does not
    // isolate — they are graded on the layer-A server instead: A8b (pin) and A11 (rename).)
    const tPre = await reclose();
    // T: the user resumes it in a TERMINAL (`claude --resume`) and types — no Orchard route at all; the CLI records the prompt.
    fs.appendFileSync(sFile, JSON.stringify({ parentUuid: null, isSidechain: false, promptId: `p-term-${Date.now()}`, type: 'user', message: { role: 'user', content: 'typed in a terminal' }, uuid: `term-${Date.now()}`, timestamp: new Date().toISOString(), promptSource: 'typed', turnOrigin: 'human', origin: { kind: 'human' }, userType: 'external', entrypoint: 'cli', cwd: w.work, sessionId: src, version: '2.1.286' }) + '\n');
    check('T1 (MUST-FAIL on round 5): a prompt typed into it OUTSIDE Orchard (CLI-recorded) reopens it', tPre && (await rowIn(api, pid, src))?.closed === false, { closedBefore: tPre, closed: (await rowIn(api, pid, src))?.closed });
  } catch (err) {
    check('F/N/T: layer ran to completion', false, String(err?.stack ?? err).slice(0, 600));
  } finally {
    await H.cleanupWorld(w);
  }
}

/** Run one layer; a crash is a recorded FAIL, never a silent skip of the layers after it. */
const ONLY = process.env.FEAT168_ONLY ? new Set(process.env.FEAT168_ONLY.split(',')) : null;
async function layer(name, fn) {
  if (ONLY && !ONLY.has(name)) return;
  try { await fn(); } catch (err) { check(`${name}: layer ran to completion`, false, String(err?.stack ?? err).slice(0, 400)); }
}

async function main() {
  console.log('\n========== FEAT-168 — mark a session CLOSED (done) ==========');
  const realBefore = fs.existsSync(REAL_STORE) ? fs.readdirSync(REAL_STORE).length : 0;
  fs.mkdirSync(WORK, { recursive: true });
  fs.mkdirSync(PROJECTS, { recursive: true });

  // The reader layers need no server.
  await layer('advLayer', () => advLayer());
  await layer('readerRound3Layer', () => readerRound3Layer());
  await layer('realArtifactLayer', () => realArtifactLayer());

  writeSession(S_CLOSE, { aiTitle: 'to be closed' });
  writeSession(S_PIN, { aiTitle: 'pre-pinned', tag: 'pinned' });
  writeSession(S_LIVE, { aiTitle: 'live one', live: true });
  writeSession(S_LIVE2, { aiTitle: 'live two', live: true });
  writeSession(S_UNIT, { aiTitle: 'unit probe' });
  writeSession(S_CROWN, { aiTitle: 'crown sync' });
  writeSession(S_RENAME, { aiTitle: 'rename while closed' });
  writeSession(S_FOREIGN, { aiTitle: 'foreign tagged', tag: 'external-triage' });
  writeSession(S_FOREIGN_LIVE, { aiTitle: 'foreign tagged live', tag: 'external-triage', live: true });
  writeSession(S_LIVE3, { aiTitle: 'live three', live: true });
  writeSession(S_BOTH, { aiTitle: 'pin and close at once' });
  writeSession(S_PINLATER, { aiTitle: 'closed then pinned' });
  writeSession(S_DELETE, { aiTitle: 'closed then deleted' });
  writeSession(S_MF, { aiTitle: 'baseline' });
  writeSession(S_MFPIN, { aiTitle: 'baseline pinned', tag: 'pinned' });
  writeSession(S_MFFOREIGN, { aiTitle: 'baseline foreign', tag: 'external-triage' });

  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  await startServer();
  const created = await req('POST', '/api/projects', { hostPath: WORK, name: 'feat168' });
  const projectId = created.json.project?.id;
  check('scratch project registered', created.status === 201 && !!projectId, `status=${created.status} id=${projectId}`);

  await layer('serverLayer', () => serverLayer(projectId));
  await layer('unitLayer', () => unitLayer());
  await layer('promptReaderLayer', () => promptReaderLayer());
  await layer('rawBytePromptReaderLayer', () => rawBytePromptReaderLayer());
  // E2E routes — before the DOM layer: app.js leaves a teardown timer (app.js queueBox) that throws once its DOM is gone
  await layer('wsLayer', () => wsLayer());
  await layer('startResumeLayer', () => startResumeLayer());
  await layer('adoptGatedLayer', () => adoptGatedLayer());
  await layer('outboxLayer', () => outboxLayer());
  await layer('survivorLayer', () => survivorLayer());
  await layer('notAPromptLayer', () => notAPromptLayer());
  await layer('domLayer', () => domLayer(projectId));

  const realAfter = fs.existsSync(REAL_STORE) ? fs.readdirSync(REAL_STORE).length : 0;
  check('ISOLATION: the user\'s real transcript store was not touched',
    realAfter === realBefore, `before=${realBefore} after=${realAfter}`);
}

main().catch((err) => { console.error(`\nFATAL: ${err.stack ?? err.message}`); fail++; }).finally(async () => {
  await stopServer();
  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exitCode = fail ? 1 : 0; // r6: the unref'd timer alone let a failing run exit 0 when the loop drained first
  setTimeout(() => process.exit(fail ? 1 : 0), 200).unref();
});
