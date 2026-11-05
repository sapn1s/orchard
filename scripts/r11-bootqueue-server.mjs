/**
 * FEAT-199 r11 — a long-lived scratch server over a crafted multi-project store,
 * for driving the r10 boot-queue (loadAllSessions) in a REAL headless browser.
 * Prints `READY <BASE> <currentProjectId>` then stays alive until SIGTERM.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { encodeCwd } from '../src/lib/session-history.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-r11-bq-data-'));
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-r11-bq-store-'));
const DAY = 24 * 3600 * 1000;
const now = Date.now();
const isoAgo = (ms) => new Date(now - ms).toISOString();

function session(dir, id, cwd, firstIso, lastIso, n) {
  const lines = [];
  for (let i = 0; i < n; i++) {
    const ts = new Date(Date.parse(firstIso) + ((Date.parse(lastIso) - Date.parse(firstIso)) * i) / Math.max(1, n - 1)).toISOString();
    const type = i % 2 ? 'assistant' : 'user';
    lines.push(JSON.stringify({ type, timestamp: ts, sessionId: id, cwd, uuid: `${id}-${i}`, parentUuid: i ? `${id}-${i - 1}` : null, version: '2.0.0', gitBranch: 'main', message: { role: type, content: type === 'user' ? `msg ${i}` : [{ type: 'text', text: `reply ${i}` }], ...(type === 'assistant' ? { model: 'claude-x' } : {}) } }));
  }
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines.join('\n') + '\n');
}

const NPROJ = 8;
const nowIso = new Date().toISOString();
const projects = [];
for (let p = 0; p < NPROJ; p++) {
  const hostPath = `/tmp/r11bq/proj_${p}`;
  fs.mkdirSync(hostPath, { recursive: true });
  const dir = path.join(STORE, encodeCwd(hostPath));
  fs.mkdirSync(dir, { recursive: true });
  // each project: a handful of sessions, recency decreasing with p
  for (let sidx = 0; sidx < 70; sidx++) {
    const id = `${String(p).padStart(2, '0')}${String(sidx).padStart(6, '0')}-0000-0000-0000-000000000000`;
    const last = isoAgo(p * DAY + sidx * 3600e3 + 1000);
    const first = isoAgo(p * DAY + sidx * 3600e3 + 7200e3);
    session(dir, id, hostPath, first, last, 4);
  }
  projects.push({ id: `p-${p}`, name: `proj_${p}`, hostPath, isolation: 'direct', settings: {}, createdAt: nowIso, updatedAt: nowIso });
}
fs.writeFileSync(path.join(DATA, 'registry.json'), JSON.stringify({ version: 1, projects }, null, 2));

const PORT = Number(process.env.BQ_PORT || 0) || (20000 + Math.floor(Math.random() * 20000));
const srv = spawn(process.execPath, [ENTRY], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE },
  stdio: ['ignore', 'inherit', 'inherit'],
});
const BASE = `http://127.0.0.1:${PORT}`;
async function waitUp() { for (let i = 0; i < 100; i++) { try { await fetch(`${BASE}/api/health`); return true; } catch { await new Promise((r) => setTimeout(r, 200)); } } return false; }
waitUp().then((up) => {
  if (!up) { console.error('NOT_READY'); process.exit(1); }
  console.log(`READY ${BASE} p-3`); // current project = p-3 (middle of the queue)
});
function cleanup() { try { srv.kill('SIGKILL'); } catch {} fs.rmSync(DATA, { recursive: true, force: true }); fs.rmSync(STORE, { recursive: true, force: true }); for (let p = 0; p < NPROJ; p++) fs.rmSync(`/tmp/r11bq/proj_${p}`, { recursive: true, force: true }); }
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('SIGINT', () => { cleanup(); process.exit(0); });
