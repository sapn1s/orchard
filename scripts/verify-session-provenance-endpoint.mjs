/**
 * Session provenance — END-TO-END through the REAL server endpoint over a REAL
 * transcript store and the REAL provenance record store (the user's actual
 * reality: real .jsonl files + real records + real GET /api/projects/:id/sessions).
 *
 * Proves the SERVER join:
 *   - a session with a 'user' RECORD  -> startedBy 'user'  (declared wins)
 *   - a session with an 'agent' RECORD -> startedBy 'agent'
 *   - a PRE-EXISTING agent session (NO record, first message = the machine
 *     Dispatch line) -> startedBy 'agent' via the conservative fallback
 *   - a plain human session (no record) -> startedBy 'user' (default shows)
 *   - a record OVERRIDES a Dispatch-looking body (declared wins over content)
 *
 * Fully isolated: scratch CLAUDE_STATION_DATA + CLAUDE_PROJECTS_DIR — the user's
 * real store is never touched.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isolatedStoreEnv } from './lib/station-boot.mjs';
import { encodeCwd } from '../src/lib/session-history.ts';
import { recordSessionProvenance } from '../src/lib/session-provenance.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-prov-ep-data-'));
const CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-prov-ep-cfg-'));
const PROJDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-prov-ep-proj-'));

let pass = 0, fail = 0;
const failures = [];
const check = (name, ok, observed) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${JSON.stringify(observed)}`);
  ok ? pass++ : (fail++, failures.push(name));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

const storeEnv = isolatedStoreEnv(CONFIG, { alsoReader: true });
const PROJECTS = storeEnv.CLAUDE_PROJECTS_DIR;
process.env.CLAUDE_STATION_DATA = DATA; // so recordSessionProvenance writes the scratch store

// ---- write a real transcript file --------------------------------------------
const encoded = encodeCwd(PROJDIR);
const dir = path.join(PROJECTS, encoded);
fs.mkdirSync(dir, { recursive: true });
function writeSession(sessionId, firstMsg, minsAgo) {
  const ts = new Date(Date.now() - minsAgo * 60000).toISOString();
  const lines = [
    { type: 'user', uuid: `${sessionId}-u`, sessionId, cwd: PROJDIR, gitBranch: 'main',
      version: '1.0.0', timestamp: ts, message: { role: 'user', content: firstMsg } },
    { type: 'assistant', uuid: `${sessionId}-a`, sessionId, cwd: PROJDIR, timestamp: ts,
      message: { role: 'assistant', model: 'claude-opus-4', content: [{ type: 'text', text: 'ok' }] } },
  ];
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

const U_PLAIN = 'aaaaaaaa-0000-4000-8000-000000000001';
const U_RECORD = 'aaaaaaaa-0000-4000-8000-000000000002';
const A_RECORD1 = 'bbbbbbbb-0000-4000-8000-000000000001';
const A_RECORD2 = 'bbbbbbbb-0000-4000-8000-000000000002';
const A_FALLBACK = 'cccccccc-0000-4000-8000-000000000001';
const U_OVERRIDE = 'dddddddd-0000-4000-8000-000000000001';

writeSession(U_PLAIN, 'can you help me fix the fill logic', 5);
writeSession(U_RECORD, 'why is the price drifting on this pair', 6);
writeSession(A_RECORD1, 'investigate the failing budget test and report', 7);
writeSession(A_RECORD2, 'BUG-301 look at the two-sided brake', 8);
writeSession(A_FALLBACK, 'Dispatch: ticket=BUG-207 phase=fixing round=1 class=fix\n\nFix the drift.', 9);
// A human whose message LOOKS like a dispatch, but declared 'user' — record wins.
writeSession(U_OVERRIDE, 'Dispatch: ticket=BUG-999 phase=fixing round=1 class=fix\n\n(a human pasted this)', 10);

// ---- records (declared provenance) -------------------------------------------
recordSessionProvenance(U_RECORD, 'user', { source: 'agent-bridge' });
recordSessionProvenance(A_RECORD1, 'agent', { source: 'dispatch:anthropic' });
recordSessionProvenance(A_RECORD2, 'agent', { source: 'dispatch:openai' });
recordSessionProvenance(U_OVERRIDE, 'user', { source: 'agent-bridge' });
// U_PLAIN and A_FALLBACK get NO record — they exercise the fallback path.

let server = null;
async function main() {
  console.log('\n========== session provenance — real endpoint join ==========');
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  server = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, ...storeEnv },
    stdio: ['ignore', 'ignore', 'pipe'], detached: true,
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(200); } }
  if (!up) throw new Error('server never became healthy');

  const reg = await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: PROJDIR, name: 'ProvProj' }),
  });
  if (!reg.ok) throw new Error(`register failed: ${await reg.text()}`);
  const { project } = await reg.json();
  const id = project.id;

  const r = await fetch(`${BASE}/api/projects/${id}/sessions`);
  if (!r.ok) throw new Error(`sessions failed: ${await r.text()}`);
  const body = await r.json();
  const by = new Map(body.sessions.map((s) => [s.sessionId, s.startedBy]));
  console.log('        session count:', body.sessions.length);

  check('plain human session (no record) -> user', by.get(U_PLAIN) === 'user', by.get(U_PLAIN));
  check("session with a 'user' record -> user", by.get(U_RECORD) === 'user', by.get(U_RECORD));
  check("session with an 'agent' record (anthropic dispatch) -> agent", by.get(A_RECORD1) === 'agent', by.get(A_RECORD1));
  check("session with an 'agent' record (openai dispatch) -> agent", by.get(A_RECORD2) === 'agent', by.get(A_RECORD2));
  check('pre-existing agent session (Dispatch line, NO record) -> agent (fallback)', by.get(A_FALLBACK) === 'agent', by.get(A_FALLBACK));
  check('human who pasted a Dispatch line but has a user record -> user (record wins)', by.get(U_OVERRIDE) === 'user', by.get(U_OVERRIDE));
  check('every session carries an explicit startedBy field',
    body.sessions.every((s) => s.startedBy === 'user' || s.startedBy === 'agent'), body.sessions.map((s) => `${s.sessionId.slice(0, 8)}:${s.startedBy}`));
}

main().catch((err) => { console.error(`\nFATAL: ${err.stack ?? err.message}`); process.exitCode = 1; })
  .finally(async () => {
    console.log(`\n${pass}/${pass + fail} checks passed`);
    if (fail) console.log(`failed: ${failures.join(' | ')}`);
    process.exitCode = fail ? 1 : (process.exitCode ?? 0);
    try { if (server?.pid) process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ }
    await sleep(300);
    for (const d of [DATA, CONFIG, PROJDIR]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
    setTimeout(() => process.exit(process.exitCode ?? 0), 300).unref();
  });
