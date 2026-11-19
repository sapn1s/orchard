#!/usr/bin/env node
/**
 * BUG-267 — every DENIED tool call tombstones its call id, including a deny that fires
 * before the git-write stage opened a claim (the BUG-230 shim-missing branch).
 *
 *   node scripts/verify-bug-267-deny-tombstone.mjs            # this checkout
 *   node scripts/verify-bug-267-deny-tombstone.mjs --mutant   # MUST-FAIL: a constructed
 *       variant of this checkout whose PreToolUse deny exit only ENDS the call (the
 *       pre-BUG-267 shape, endGitCall) instead of tombstoning it (denyGitCall)
 *
 * E2E, the user's reality: a REAL scratch server (isolatedServerEnv, a throwaway repo
 * only) launches a direct session whose fake CLI (scripts/fixtures/bug-231/fake-cli.mjs)
 * drives the runtime's REAL PreToolUse hook and runs the command with the session's git
 * shim first on PATH. The shim dir is made unsafe (group/other-writable) so the hook's
 * BUG-230 ensure() refuses: the call is denied before evaluateGitWriteAsync. Then the
 * shim is made safe again, the USER issues a once-grant, and the CLI re-sends the SAME
 * tool_use_id (the retry shape verify 9614f08f probed), followed by a genuine new call.
 *
 * PROPERTY: the retried id is refused and spends nothing; the once-grant reaches the
 * agent's NEXT call, which commits.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { mkdtempScratch } from './lib/scratch.mjs';
import { isolatedServerEnv, isolatedStoreEnv } from './lib/station-boot.mjs';
import { buildMutantTree } from './lib/mutant-tree.mjs';

const HERE = path.resolve(import.meta.dirname, '..');
const MUTANT = process.argv.includes('--mutant');
const FAKE_CLI = path.join(HERE, 'scripts', 'fixtures', 'bug-231', 'fake-cli.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const INVOKER_SHIM = process.env.ORCHARD_GIT_SHIM_DIR;
process.env.PATH = String(process.env.PATH ?? '').split(path.delimiter)
  .filter((p) => p && p !== INVOKER_SHIM && !path.basename(p).startsWith('orchard-git-shim-'))
  .join(path.delimiter);
delete process.env.ORCHARD_GIT_SHIM_DIR;
delete process.env.ORCHARD_ALLOW_GIT_WRITE;
const REAL_GIT = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();

let pass = 0, fail = 0;
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else fail++;
}
const readJsonl = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
async function freePort() {
  return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
}

let ROOT = HERE;
if (MUTANT) {
  ROOT = buildMutantTree({
    copy: ['src'], prefix: 'bug267-mutant-',
    edits: [{
      file: 'src/server/runtime/claude-runtime.ts',
      from: "if (d === 'deny') denyGitCall((input as { tool_use_id?: unknown } | undefined)?.tool_use_id, (input as { agent_id?: unknown } | undefined)?.agent_id);",
      to: "if (d === 'deny') endGitCall((input as { tool_use_id?: unknown } | undefined)?.tool_use_id);",
    }],
  });
}
console.log(`tree under test: ${MUTANT ? `MUTANT (PreToolUse deny exit only ends the call) ${ROOT}` : 'this checkout'}`);

const RUN = mkdtempScratch('bug267-');
const git = (dir, ...a) => { const env = { ...process.env }; delete env.GIT_INDEX_FILE; return spawnSync(REAL_GIT, a, { cwd: dir, encoding: 'utf8', env }); };
const repo = path.join(RUN, 'repo'); fs.mkdirSync(repo);
git(repo, 'init', '-q'); git(repo, 'config', 'user.email', 'b267@example.invalid'); git(repo, 'config', 'user.name', 'b267');
fs.writeFileSync(path.join(repo, 'README.md'), 'bug-267 throwaway\n');
git(repo, 'add', 'README.md'); git(repo, 'commit', '-q', '-m', 'base');
const count = () => Number(git(repo, 'rev-list', '--count', 'HEAD').stdout.trim());

const out = path.join(RUN, 'fake-start.jsonl');
const results = path.join(RUN, 'fake-results.jsonl');
const PORT = await freePort();
const DATA = fs.mkdtempSync(path.join(RUN, 'data-'));
const STORE = fs.mkdtempSync(path.join(RUN, 'store-'));
const env = isolatedServerEnv({
  PORT: String(PORT), CLAUDE_STATION_DATA: DATA, ...isolatedStoreEnv(STORE, { alsoReader: true }),
  CLAUDE_STATION_CLAUDE_BIN: FAKE_CLI, CLAUDE_STATION_MCP_READY_TIMEOUT_MS: '0',
  CLAUDE_STATION_SURVIVE: '0', FAKE_OUT: out, FAKE_RESULTS: results, FAKE_REPO: repo,
});
const srv = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
const BASE = `http://127.0.0.1:${PORT}`;
let ws = null;
let shimDir = null;
try {
  let up = false;
  for (let i = 0; i < 200 && !up; i++) { try { up = (await fetch(`${BASE}/api/projects`)).ok; } catch { /* booting */ } if (!up) await sleep(150); }
  if (!up) throw new Error(`scratch server did not boot: ${log.slice(-800)}`);
  const reg = await (await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: repo, name: 'b267-throwaway', isolation: 'direct', applyMethod: false }) })).json();
  const projectId = reg.project?.id;
  if (!projectId) throw new Error(`project not registered: ${JSON.stringify(reg)}`);
  const grantUrl = `${BASE}/api/projects/${encodeURIComponent(projectId)}/git-write-grant`;
  const grant = async (scope) => (await fetch(grantUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope }) })).json();
  const grantState = async () => (await (await fetch(grantUrl)).json());

  ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const events = [];
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => { try { events.push(JSON.parse(String(e.data))); } catch { /* ignore */ } };
  for (let t = 0; t < 40 && readJsonl(out).length === 0; t++) {
    const seen = events.length;
    ws.send(JSON.stringify({ type: 'start', projectId, overrides: { model: 'haiku', permissionMode: 'bypassPermissions' }, prompt: 'hi' }));
    let pending = false;
    for (let i = 0; i < 30; i++) {
      await sleep(100);
      if (events.slice(seen).some((e) => e.code === 'runtime-check-pending')) { pending = true; break; }
      if (readJsonl(out).length) break;
    }
    if (!pending) break;
    await sleep(1500);
  }
  for (let i = 0; i < 100 && readJsonl(out).length === 0; i++) await sleep(100);
  shimDir = readJsonl(out)[0]?.shimDir ?? null;
  check('R0 non-vacuity: the session got its own git shim, first on PATH', !!shimDir && readJsonl(out)[0].pathHead === shimDir, readJsonl(out)[0] ?? log.slice(-400));
  if (!shimDir) throw new Error('no shim');
  await sleep(800);
  async function bash(spec) {
    const before = readJsonl(results).length;
    ws.send(JSON.stringify({ type: 'send', prompt: `[[bash]]${JSON.stringify(spec)}` }));
    for (let i = 0; i < 600 && readJsonl(results).length <= before; i++) await sleep(100);
    await sleep(400);
    return readJsonl(results)[before] ?? { error: 'no result (timeout)' };
  }

  const ID = `toolu_267_retry_${process.pid}`;
  const c0 = count();
  // 1 — the shim dir becomes unsafe: the hook's BUG-230 ensure() refuses, before the git stage.
  fs.chmodSync(shimDir, 0o777);
  const a = await bash({ tag: 'a', toolUseId: ID, command: 'git commit --allow-empty -q -m retry-target' });
  fs.chmodSync(shimDir, 0o700);
  check('R1 setup: the call is DENIED by the BUG-230 shim-missing branch (before evaluateGitWriteAsync)', a.pre?.verdict === 'deny' && /BUG-230/.test(a.pre?.text ?? '') && !a.ran, { pre: a.pre?.verdict, text: String(a.pre?.text ?? '').slice(0, 120), ran: a.ran });
  // 2 — the user grants once, after the deny.
  const g = await grant('once');
  check('R2 setup: the user\'s once-grant is issued after the deny', g?.grant?.scope === 'once', g);
  // 3 — the CLI re-sends the SAME tool_use_id.
  const b = await bash({ tag: 'b', toolUseId: ID, command: 'git commit --allow-empty -q -m retry-target' });
  check('R3 the denied id\'s RETRY is refused and commits nothing', b.pre?.verdict === 'deny' && !b.ran && count() === c0, { pre: b.pre?.verdict, ran: b.ran, exit: b.exit, commits: count() - c0 });
  const st = (await grantState()).grant;
  check('R4 the once-grant is still unspent after the retry', !!st && st.scope === 'once' && st.remainingUses === 1 && !st.reserved, st);
  // 4 — the agent's NEXT genuine call (a new id) gets the grant.
  const c = await bash({ tag: 'c', command: 'git commit --allow-empty -q -m next-call' });
  check('R5 the agent\'s NEXT call (a new id) uses the once-grant and commits', c.pre?.verdict !== 'deny' && c.exit === 0 && count() === c0 + 1, { pre: c.pre?.verdict, text: String(c.pre?.text ?? '').slice(0, 100), exit: c.exit, stderr: c.stderr?.slice(0, 160), commits: count() - c0 });
  check('R6 …and the once-grant is spent by it', (await grantState()).grant === null, (await grantState()).grant);
} catch (e) {
  check(`suite threw: ${String(e?.stack ?? e).split('\n').slice(0, 2).join(' | ')}`, false, log.slice(-600));
} finally {
  try { if (shimDir) fs.chmodSync(shimDir, 0o700); } catch { /* gone */ }
  try { ws?.close(); } catch { /* ignore */ }
  try { process.kill(srv.pid, 'SIGTERM'); } catch { /* gone */ }
  for (let i = 0; i < 40 && srv.exitCode === null && srv.signalCode === null; i++) await sleep(150);
  try { process.kill(srv.pid, 'SIGKILL'); } catch { /* gone */ }
  fs.rmSync(RUN, { recursive: true, force: true });
  if (MUTANT) fs.rmSync(ROOT, { recursive: true, force: true });
}
console.log(`\nBUG-267 deny tombstone (${MUTANT ? 'MUTANT' : 'this checkout'}): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
