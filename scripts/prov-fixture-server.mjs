/**
 * Boots an ISOLATED Orchard server pre-seeded with a realistic busy-project
 * fixture for the session-provenance picker fold, and stays up until killed.
 * Used by the real-browser (brave-CDP) verification — NOT a checked assertion
 * suite. Prints a JSON line `FIXTURE_READY {...}` with the base URL, project id,
 * and the session ids so the driver can build deep-link URLs.
 *
 * Fully isolated (scratch CLAUDE_STATION_DATA + CLAUDE_PROJECTS_DIR); the user's
 * real store is never touched. On SIGTERM/SIGINT it tears the server down and
 * removes its scratch dirs.
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
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-prov-fx-data-'));
const CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-prov-fx-cfg-'));
const PROJDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-prov-fx-proj-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const storeEnv = isolatedStoreEnv(CONFIG, { alsoReader: true });
process.env.CLAUDE_STATION_DATA = DATA;

const encoded = encodeCwd(PROJDIR);
const dir = path.join(storeEnv.CLAUDE_PROJECTS_DIR, encoded);
fs.mkdirSync(dir, { recursive: true });
function writeSession(sessionId, firstMsg, minsAgo, msgs = 12) {
  const ts = new Date(Date.now() - minsAgo * 60000).toISOString();
  const lines = [{ type: 'user', uuid: `${sessionId}-u`, sessionId, cwd: PROJDIR, gitBranch: 'main',
    version: '1.0.0', timestamp: ts, message: { role: 'user', content: firstMsg } }];
  for (let i = 0; i < msgs; i++) {
    lines.push({ type: 'assistant', uuid: `${sessionId}-a${i}`, sessionId, cwd: PROJDIR, timestamp: ts,
      message: { role: 'assistant', model: 'claude-opus-4', content: [{ type: 'text', text: 'working…' }] } });
  }
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  // BACKDATE the file mtime to its logical age. Server liveness is mtime-based
  // (liveness.ts LIVE_WINDOW_MS = 30s): a freshly-written file reads as LIVE for
  // ~30s, and a live session is never folded — so without this every seeded row
  // would spuriously fold-exempt for the first half-minute (the exact false
  // negative a real-browser pass hit). minsAgo here is always > 0.5min.
  const when = new Date(Date.now() - minsAgo * 60000);
  try { fs.utimesSync(file, when, when); } catch { /* best-effort */ }
}

// Two human sessions the user actually opened, plus SIX agent-dispatched rows
// (ticket-titled) — the busy-day shape that buries the human's threads.
const users = [
  ['aaaa0000-0000-4000-8000-000000000001', 'help me fix the fill logic', 3],
  ['aaaa0000-0000-4000-8000-000000000002', 'why is the price drifting on this pair', 5],
];
const agents = [
  ['bbbb0000-0000-4000-8000-000000000001', 'investigate the failing budget test', 7],
  ['bbbb0000-0000-4000-8000-000000000002', 'BUG-301 two-sided brake regression', 9],
  ['bbbb0000-0000-4000-8000-000000000003', 'verify the price-drift fix, round 2', 11],
  ['bbbb0000-0000-4000-8000-000000000004', 'BUG-305 budget fill adversarial pass', 13],
  ['bbbb0000-0000-4000-8000-000000000005', 'FEAT-112 sidecar reachability probe', 15],
  ['cccc0000-0000-4000-8000-000000000001', 'Dispatch: ticket=BUG-207 phase=fixing round=1 class=fix\n\nfix drift', 17],
];
for (const [id, msg, mins] of users) writeSession(id, msg, mins);
for (const [id, msg, mins] of agents) writeSession(id, msg, mins);
// Records for all but the last agent (which exercises the pre-existing fallback).
for (const [id] of users) recordSessionProvenance(id, 'user', { source: 'agent-bridge' });
for (const [id] of agents.slice(0, 5)) recordSessionProvenance(id, 'agent', { source: 'dispatch:anthropic' });

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

let server = null;
function cleanup() {
  try { if (server?.pid) process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ }
  for (const d of [DATA, CONFIG, PROJDIR]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
}
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('SIGINT', () => { cleanup(); process.exit(0); });

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
server = spawn(process.execPath, [ENTRY], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, ...storeEnv },
  stdio: ['ignore', 'ignore', 'inherit'], detached: true,
});
let up = false;
for (let i = 0; i < 80 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(200); } }
if (!up) { cleanup(); throw new Error('server never became healthy'); }
const reg = await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: PROJDIR, name: 'TradingVol' }) });
const { project } = await reg.json();

console.log('FIXTURE_READY ' + JSON.stringify({
  base: BASE, projectId: project.id, encodedDir: encoded,
  userSessions: users.map((u) => u[0]), agentSessions: agents.map((a) => a[0]),
}));
// Stay up until killed.
setInterval(() => {}, 1 << 30);
