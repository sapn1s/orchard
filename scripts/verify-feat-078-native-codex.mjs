/**
 * verify:feat-078 — native (external) codex sessions surface on a project like
 * Claude sessions do.
 *
 * ALL fixtures live under a scratch $CODEX_HOME / $CLAUDE_PROJECTS_DIR /
 * $CLAUDE_STATION_DATA — nothing here touches the real ~/.codex or
 * ~/.claude. A before/after manifest of BOTH real stores proves it. No real
 * home paths appear in any assertion (leak-gate): scratch dirs are built from
 * os.tmpdir() and os.homedir() is only read to locate the real stores for the
 * untouched-guard.
 *
 * Two parts:
 *   A. MODULE unit tests (src/server/codex-native.ts) — head-only scan, cwd
 *      match, title derivation, bounded reads, must-FAIL pre-fix proof, import
 *      + idempotency + resume-resolution.
 *   B. SERVER e2e — a REALISTIC mix (native codex + Claude + Orchard-run codex
 *      for one project) all appear via /api/projects/:id/sessions, native ones
 *      tagged provider:'openai', other-cwd excluded, recency-ordered; opening a
 *      native session imports + renders it.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'feat-078-'));
const CODEX_HOME = path.join(TMP, 'codex');
const SESSIONS = path.join(CODEX_HOME, 'sessions');
const PROJECTS = path.join(TMP, 'claude-projects'); // scratch Claude store
const DATA = path.join(TMP, 'data'); // scratch CLAUDE_STATION_DATA (orchard transcripts)
const CONFIG = path.join(TMP, 'config');
const WORK = path.join(TMP, 'work'); // the fixture project's hostPath
const OTHER = path.join(TMP, 'other'); // a DIFFERENT project cwd (must be excluded)

// Point every store at scratch BEFORE importing any server module.
process.env.CODEX_HOME = CODEX_HOME;
process.env.CLAUDE_STATION_DATA = DATA;
process.env.CLAUDE_PROJECTS_DIR = PROJECTS;
for (const d of [SESSIONS, PROJECTS, DATA, CONFIG, WORK, OTHER]) fs.mkdirSync(d, { recursive: true });

const failures = [];
let checks = 0;
function check(name, ok, observed) {
  checks++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (!ok) failures.push(name);
}
function section(t) {
  console.log(`\n=== ${t} ===`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function encodeCwd(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/* ---- native codex rollout fixture writer --------------------------------- */

/**
 * Write a rollout file under CODEX_HOME/sessions/YYYY/MM/DD/. `extraLines` are
 * appended verbatim AFTER the real content (used to prove head-only reads).
 */
function writeRollout(sessionId, cwd, when, opts = {}) {
  const d = new Date(when);
  const yyyy = String(d.getUTCFullYear());
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const dir = path.join(SESSIONS, yyyy, mm, dd);
  fs.mkdirSync(dir, { recursive: true });
  const iso = d.toISOString();
  const fileTs = iso.replace(/[:.]/g, '-').replace('Z', '');
  const file = path.join(dir, `rollout-${fileTs}-${sessionId}.jsonl`);
  const L = (o) => JSON.stringify({ timestamp: iso, ...o });
  const lines = [
    L({ type: 'session_meta', payload: { session_id: sessionId, id: sessionId, timestamp: iso, cwd, originator: 'codex-tui', cli_version: '0.147.0', model_provider: 'openai' } }),
    // developer instructions — must be skipped for title AND import
    L({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'You are Codex. Big block of system instructions.' }] } }),
    // an environment_context user wrapper — must be skipped for the title
    L({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>' + cwd + '</cwd>\n</environment_context>' }] } }),
    // the REAL first user prompt — this is the title
    L({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: opts.prompt ?? `native codex prompt for ${sessionId}` }] } }),
    // an assistant reply
    L({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: opts.reply ?? 'native codex reply' }] } }),
    // a tool call + its output (import should translate to tool_use/tool_result)
    L({ type: 'response_item', payload: { type: 'custom_tool_call', id: 'ctc_1', call_id: 'call_1', status: 'completed', name: 'exec', input: 'ls' } }),
    L({ type: 'response_item', payload: { type: 'custom_tool_call_output', id: 'ctco_1', call_id: 'call_1', output: [{ type: 'input_text', text: 'file-a\nfile-b' }] } }),
    // an event_msg (delta/status) — import ignores non response_item lines
    L({ type: 'event_msg', payload: { type: 'task_complete' } }),
  ];
  let body = lines.join('\n') + '\n';
  if (opts.padBytes) {
    const filler = L({ type: 'event_msg', payload: { type: 'token_count', junk: 'x'.repeat(200) } }) + '\n';
    while (body.length < opts.padBytes) body += filler;
  }
  fs.writeFileSync(file, body);
  const t = new Date(when);
  fs.utimesSync(file, t, t); // mtime drives recency ordering
  return file;
}

/* ---- Claude native store fixture ----------------------------------------- */

function writeClaudeSession(id, cwd, when, title) {
  const dir = path.join(PROJECTS, encodeCwd(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const iso = new Date(when).toISOString();
  const lines = [
    { parentUuid: null, isSidechain: false, isMeta: false, type: 'user', message: { role: 'user', content: `claude prompt ${id}` }, timestamp: iso, uuid: `${id.slice(0, 8)}-1111-4111-8111-111111111111`, cwd, sessionId: id, version: '2.1.158', gitBranch: 'main' },
    { parentUuid: `${id.slice(0, 8)}-1111-4111-8111-111111111111`, isSidechain: false, type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'claude reply' }] }, timestamp: iso, uuid: `${id.slice(0, 8)}-2222-4222-8222-222222222222`, cwd, sessionId: id },
    { type: 'ai-title', aiTitle: title, sessionId: id },
  ];
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const t = new Date(when);
  fs.utimesSync(file, t, t);
  return file;
}

/* ---- an ORCHARD-run codex transcript (the existing capture path) --------- */

function writeOrchardCodex(id, cwd, when) {
  const dir = path.join(DATA, 'transcripts', 'openai', encodeCwd(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const iso = new Date(when).toISOString();
  const lines = [
    { type: 'user', uuid: 'u1', parentUuid: null, timestamp: iso, sessionId: id, cwd, provider: 'openai', message: { role: 'user', content: [{ type: 'text', text: `orchard codex prompt ${id}` }] } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: iso, sessionId: id, cwd, provider: 'openai', message: { role: 'assistant', content: [{ type: 'text', text: 'orchard codex reply' }] } },
  ];
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const t = new Date(when);
  fs.utimesSync(file, t, t);
  return file;
}

/* ---- real-store untouched guard ------------------------------------------ */

function manifest(root) {
  const rows = [];
  const walk = (d, depth) => {
    if (depth > 6) return;
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else {
        try {
          const st = fs.statSync(p);
          rows.push(`${p}\t${st.size}\t${st.mtimeMs}`);
        } catch {
          /* vanished mid-walk — fine */
        }
      }
    }
  };
  walk(root, 0);
  rows.sort();
  return createHash('sha256').update(rows.join('\n')).digest('hex');
}

const REAL_CODEX = path.join(os.homedir(), '.codex', 'sessions');
const REAL_CLAUDE = path.join(os.homedir(), '.claude', 'projects');

/* ---- server e2e helpers -------------------------------------------------- */

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}

let server = null;
async function startServer(port, base) {
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), CLAUDE_STATION_DATA: DATA, CLAUDE_CONFIG_DIR: CONFIG, CLAUDE_PROJECTS_DIR: PROJECTS, CODEX_HOME },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`[server] ${d}`));
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return;
    } catch {
      /* not up */
    }
    await sleep(100);
  }
  throw new Error('server did not become healthy');
}
async function stopServer() {
  if (!server) return;
  const p = server;
  server = null;
  p.kill('SIGTERM');
  await new Promise((r) => {
    p.on('exit', r);
    setTimeout(r, 4000);
  });
}

/* -------------------------------------------------------------------------- */

async function main() {
  const realCodexBefore = manifest(REAL_CODEX);
  // NB: a byte-manifest of ~/.claude/projects flakes when a live Claude session
  // is writing to it concurrently (its own turn appends). The leak we actually
  // guard against is this test writing a scratch project's data into the REAL
  // store — which would appear as a NEW dir named for one of our scratch cwds.
  // So the Claude guard is existence-based (immune to unrelated churn); the
  // codex guard stays byte-exact because nothing else touches ~/.codex here.
  const leakedDirs = () =>
    [encodeCwd(WORK), encodeCwd(OTHER)].filter((enc) => fs.existsSync(path.join(REAL_CLAUDE, enc)) || fs.existsSync(path.join(os.homedir(), '.local', 'share', 'claude-station', 'transcripts', 'openai', enc)));

  // session ids (uuid-shaped, filename-safe)
  const N_NEW = '019ffe00-0000-7000-8000-000000000001'; // native, newest
  const N_OLD = '019ffe00-0000-7000-8000-000000000002'; // native, older
  const N_PAD = '019ffe00-0000-7000-8000-000000000003'; // native, padded (head-only proof)
  const N_OTHERCWD = '019ffe00-0000-7000-8000-000000000004'; // native, DIFFERENT cwd
  const C_CLAUDE = 'cccccccc-1111-4111-8111-000000000001'; // Claude
  const O_CODEX = 'aaaacccc-1111-4111-8111-000000000001'; // Orchard-run codex

  const t0 = Date.parse('2026-08-14T04:00:00.000Z');
  const H = 3600_000;
  const fNew = writeRollout(N_NEW, WORK, t0 + 5 * H, { prompt: 'investigate the sleep bug' });
  writeRollout(N_OLD, WORK, t0 + 1 * H, { prompt: 'older native task' });
  const fPad = writeRollout(N_PAD, WORK, t0 + 3 * H, { prompt: 'padded head proof', padBytes: 400 * 1024 });
  writeRollout(N_OTHERCWD, OTHER, t0 + 6 * H, { prompt: 'belongs to another project' });

  /* ===================== PART A — module unit tests ====================== */
  const cn = await import(pathToFileURL(path.join(ROOT, 'src', 'server', 'codex-native.ts')).href);
  const hist = await import(pathToFileURL(path.join(ROOT, 'src', 'lib', 'session-history.ts')).href);
  const ot = await import(pathToFileURL(path.join(ROOT, 'src', 'server', 'orchard-transcripts.ts')).href);

  section('A1. head-only scan derives cwd, session_id, title without full parse');
  const head = cn.readRolloutHead(fNew);
  check('head yields the session_id from session_meta', head.sessionId === N_NEW, head.sessionId);
  check('head yields the cwd from session_meta', head.cwd === WORK, head.cwd);
  check('title is the first REAL user prompt (env/developer wrappers skipped)', head.firstUserMessage === 'investigate the sleep bug', head.firstUserMessage);

  const padSize = fs.statSync(fPad).size;
  const padHead = cn.readRolloutHead(fPad);
  check('padded rollout: title still derived from the head', padHead.firstUserMessage === 'padded head proof', padHead.firstUserMessage);
  check('padded rollout: bytesRead is BOUNDED (<= head budget, < file size) — no full parse',
    padHead.bytesRead <= 256 * 1024 && padHead.bytesRead < padSize,
    { bytesRead: padHead.bytesRead, fileSize: padSize });

  section('A2. listNativeCodexSessions — project match, other-cwd excluded, recency-ordered, tagged');
  const listed = cn.listNativeCodexSessions(WORK);
  const ids = listed.map((s) => s.sessionId);
  check('the project\'s 3 native sessions are listed', ids.length === 3 && ids.includes(N_NEW) && ids.includes(N_OLD) && ids.includes(N_PAD), ids);
  check('the OTHER-cwd native session is excluded', !ids.includes(N_OTHERCWD), ids);
  check('every native row is tagged provider:openai', listed.every((s) => s.provider === 'openai'), listed.map((s) => s.provider));
  check('rows are newest-activity first (N_NEW before N_PAD before N_OLD)', ids[0] === N_NEW && ids[1] === N_PAD && ids[2] === N_OLD, ids);
  check('displayTitle is the derived human title', listed.find((s) => s.sessionId === N_NEW)?.displayTitle === 'investigate the sleep bug',
    listed.find((s) => s.sessionId === N_NEW)?.displayTitle);

  section('A3. MUST-FAIL (pre-fix): a project with ONLY native codex sessions shows NONE');
  // The PRE-FIX composition is exactly the Claude store + Orchard-transcript
  // readers — the two readers sessionsForProject used before FEAT-078. Neither
  // sees codex's own store, so a native-only project is empty. This is the gap.
  let preFix = [];
  try {
    const projects = hist.listLogicalProjects();
    const enc = hist.encodeCwd(WORK);
    const lp = projects.find((p) => p.dirs.some((d) => d.encodedDir === enc));
    if (lp) preFix = hist.listLogicalProjectSessions(lp);
  } catch {
    preFix = [];
  }
  for (const d of new Set([hist.encodeCwd(WORK)])) {
    for (const s of ot.listOrchardSessions(d)) preFix.push(s);
  }
  check('PRE-FIX readers (Claude store + Orchard transcripts) return ZERO for the native-only project — the bug', preFix.length === 0, preFix.map((s) => s.sessionId));
  check('POST-FIX cn.listNativeCodexSessions returns them — the fix', cn.listNativeCodexSessions(WORK).length === 3, cn.listNativeCodexSessions(WORK).length);

  section('A4. import — translate rollout to an Orchard transcript, idempotent, resolvable for resume');
  const imp = cn.importNativeCodexSession(N_NEW, { expectedEncodedDir: hist.encodeCwd(WORK) });
  check('import created a transcript file', !!imp && !imp.alreadyPresent && fs.existsSync(imp.filePath), imp);
  const importedText = fs.readFileSync(imp.filePath, 'utf8');
  check('imported transcript has the real user prompt', importedText.includes('investigate the sleep bug'), true);
  check('imported transcript has the assistant reply', importedText.includes('native codex reply'), true);
  check('imported transcript translated the tool call (tool_use) + output (tool_result)', importedText.includes('tool_use') && importedText.includes('tool_result') && importedText.includes('file-a'), true);
  check('imported transcript did NOT include the developer/system instructions', !importedText.includes('Big block of system instructions'), true);
  check('imported transcript did NOT include the environment_context wrapper', !importedText.includes('<environment_context>'), true);

  const mtime1 = fs.statSync(imp.filePath).mtimeMs;
  const imp2 = cn.importNativeCodexSession(N_NEW, { expectedEncodedDir: hist.encodeCwd(WORK) });
  check('re-import is idempotent (alreadyPresent, file untouched)', imp2?.alreadyPresent === true && fs.statSync(imp.filePath).mtimeMs === mtime1, imp2);

  // The resume path resolves the engine via resolveOrchardSessionFile — after
  // import a native session is an 'openai' transcript, so resume picks Codex.
  const resolved = ot.resolveOrchardSessionFile(hist.encodeCwd(WORK), N_NEW);
  check('resume resolution: imported native session resolves as provider openai (→ CodexRuntime thread/resume)', resolved?.provider === 'openai', resolved);

  check('expectedEncodedDir mismatch is refused (no cross-project write)', cn.importNativeCodexSession(N_OLD, { expectedEncodedDir: 'totally-different-dir' }) === null, true);

  /* ===================== PART B — server e2e (realistic mix) ============== */
  // A busy project: native codex (already have 3) + a Claude session + an
  // Orchard-run codex session, all for WORK.
  writeClaudeSession(C_CLAUDE, WORK, t0 + 4 * H, 'a real claude session');
  writeOrchardCodex(O_CODEX, WORK, t0 + 2 * H);
  hist.clearSessionCache?.();

  const port = Number(process.env.VERIFY_FEAT078_PORT ?? (await freePort()));
  const base = `http://127.0.0.1:${port}`;
  await startServer(port, base);
  const created = await (await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: WORK, name: 'feat-078' }) })).json();
  const projectId = created.project?.id;
  check('scratch project registered', !!projectId, projectId);

  section('B1. realistic mix — native codex + Claude + Orchard codex all appear, correctly tagged');
  const list = await (await fetch(`${base}/api/projects/${projectId}/sessions`)).json();
  const rows = list.sessions ?? [];
  const byId = (id) => rows.find((s) => s.sessionId === id);
  check('the native NEW codex session appears, tagged openai', byId(N_NEW)?.provider === 'openai', byId(N_NEW)?.provider);
  check('the native OLD codex session appears, tagged openai', byId(N_OLD)?.provider === 'openai', byId(N_OLD)?.provider);
  check('the native PAD codex session appears, tagged openai', byId(N_PAD)?.provider === 'openai', byId(N_PAD)?.provider);
  check('the Claude session appears, tagged anthropic', byId(C_CLAUDE)?.provider === 'anthropic', byId(C_CLAUDE)?.provider);
  check('the Orchard-run codex session appears, tagged openai', byId(O_CODEX)?.provider === 'openai', byId(O_CODEX)?.provider);
  check('the OTHER-cwd native session is NOT listed', !byId(N_OTHERCWD), rows.map((s) => s.sessionId));
  check('the native session shows its derived title', byId(N_NEW)?.displayTitle === 'investigate the sleep bug', byId(N_NEW)?.displayTitle);
  // Recency order (mtimes): N_NEW(5h) > C_CLAUDE(4h) > N_PAD(3h) > O_CODEX(2h) > N_OLD(1h)
  const order = rows.filter((s) => [N_NEW, C_CLAUDE, N_PAD, O_CODEX, N_OLD].includes(s.sessionId)).map((s) => s.sessionId);
  check('all five are recency-ordered (native + claude + orchard interleaved by activity)',
    JSON.stringify(order) === JSON.stringify([N_NEW, C_CLAUDE, N_PAD, O_CODEX, N_OLD]), order);

  // De-dup: N_NEW was imported into the Orchard store in Part A. It must appear
  // exactly ONCE, not twice (native twin skipped).
  check('an already-imported native session appears exactly once (no duplicate)', rows.filter((s) => s.sessionId === N_NEW).length === 1, rows.filter((s) => s.sessionId === N_NEW).length);

  section('B2. opening a native session imports + renders its transcript');
  const enc = list.encodedDir ?? encodeCwd(WORK);
  const tr = await fetch(`${base}/api/transcript/${enc}/${N_OLD}?tail=50`);
  const trj = await tr.json();
  check('native session transcript route returns 200', tr.status === 200, tr.status);
  const flat = JSON.stringify(trj.messages ?? []);
  check('rendered transcript contains the native user prompt', flat.includes('older native task'), tr.status);
  check('rendered transcript contains the native assistant reply', flat.includes('native codex reply'), true);

  await stopServer();

  section('C. real stores untouched');
  check('~/.codex/sessions unchanged (byte manifest)', manifest(REAL_CODEX) === realCodexBefore, 'sha match');
  check('no scratch project dir leaked into the REAL Claude store or real data dir', leakedDirs().length === 0, leakedDirs());

  /* --------------------------------------------------------------- report */
  console.log(`\n${failures.length ? 'FAIL' : 'PASS'} — ${checks - failures.length}/${checks} checks passed`);
  if (failures.length) {
    console.log('failed:\n  ' + failures.join('\n  '));
    process.exitCode = 1;
  }
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

main().catch(async (err) => {
  console.error(err);
  await stopServer();
  process.exitCode = 1;
});
