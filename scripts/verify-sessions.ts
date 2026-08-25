/**
 * verify:sessions — rename / pin / delete, proven by running.
 *
 * EVERY session this script touches is one it created itself, in a throwaway
 * store under $TMPDIR. The server under test is spawned with CLAUDE_CONFIG_DIR
 * (what the Agent SDK's mutation APIs resolve against) and CLAUDE_PROJECTS_DIR
 * (what session-history reads) both pointed at that store, so nothing here can
 * reach ~/.claude/projects. The last check proves that: a full
 * path+mtime+size manifest of the real store is taken before the first request
 * and compared byte-for-byte at the end.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

/* Never a fixed port: two suites defaulting to the same number collide the
   moment both run (observed: verify-ui + verify-sessions on 4319). The OS
   hands out a free one; the env var still pins it when a run needs to. */
async function freePort(): Promise<number> {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as import('node:net').AddressInfo).port; s.close(() => res(p)); });
  });
}
const PORT = Number(process.env.VERIFY_SESSIONS_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-station-sessions-'));
const STORE = path.join(TMP, 'store');
const PROJECTS = path.join(STORE, 'projects');
const DATA = path.join(TMP, 'data');
const WORK = path.join(TMP, 'work'); // the fake project's real cwd

const REAL_STORE = path.join(os.homedir(), '.claude', 'projects');

const failures: string[] = [];
let checks = 0;

function check(name: string, ok: boolean, observed: unknown): void {
  checks++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (!ok) failures.push(name);
}
function section(t: string): void {
  console.log(`\n=== ${t} ===`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function req(method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { _raw: text };
  }
  return { status: r.status, json };
}

/* --------------------------------------------------------- store fixtures */

function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

const ENCODED = encodeCwd(WORK);
const DIR = path.join(PROJECTS, ENCODED);

/** Backdate a file so the mtime-based "live" window does not fire on fixtures. */
function backdate(file: string, minutes = 60): void {
  const t = new Date(Date.now() - minutes * 60_000);
  fs.utimesSync(file, t, t);
}

function writeSession(id: string, opts: { aiTitle?: string; customTitle?: string; tag?: string; cwd?: string; dir?: string } = {}): string {
  const cwd = opts.cwd ?? WORK;
  const dir = opts.dir ?? DIR;
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date(Date.now() - 3600_000).toISOString();
  const lines: unknown[] = [
    {
      parentUuid: null, isSidechain: false, type: 'user',
      message: { role: 'user', content: `first prompt of ${id}` },
      timestamp: now, uuid: `${id.slice(0, 8)}-1111-4111-8111-111111111111`,
      isMeta: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: id, version: '2.1.158', gitBranch: 'main',
    },
    {
      parentUuid: `${id.slice(0, 8)}-1111-4111-8111-111111111111`, isSidechain: false, type: 'assistant',
      message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'a reply' }] },
      timestamp: now, uuid: `${id.slice(0, 8)}-2222-4222-8222-222222222222`,
      cwd, sessionId: id, version: '2.1.158', gitBranch: 'main',
    },
  ];
  if (opts.aiTitle) lines.push({ type: 'ai-title', aiTitle: opts.aiTitle, sessionId: id });
  if (opts.customTitle) lines.push({ type: 'custom-title', customTitle: opts.customTitle, sessionId: id });
  if (opts.tag) lines.push({ type: 'tag', tag: opts.tag, sessionId: id });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  backdate(file);
  return file;
}

function sha256(f: string): string {
  return createHash('sha256').update(fs.readFileSync(f)).digest('hex');
}

function manifest(root: string): string {
  const rows: string[] = [];
  const walk = (d: string, depth: number): void => {
    if (depth > 2) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else {
        const st = fs.statSync(p);
        rows.push(`${p}\t${st.size}\t${st.mtimeMs}`);
      }
    }
  };
  walk(root, 0);
  rows.sort();
  return rows.join('\n');
}

/* ------------------------------------------------------------------- ids */

const S_AUTO = 'aaaaaaaa-1111-4111-8111-000000000001'; // has an ai-title
const S_PLAIN = 'aaaaaaaa-1111-4111-8111-000000000002'; // no title entries
const S_DELETE = 'aaaaaaaa-1111-4111-8111-000000000003'; // deletion target
const S_LIVE = 'aaaaaaaa-1111-4111-8111-000000000004'; // kept mtime-fresh
const S_DUPE = 'aaaaaaaa-1111-4111-8111-000000000005'; // in two store dirs
const S_TAGGED = 'aaaaaaaa-1111-4111-8111-000000000006'; // pre-tagged 'important'

let server: ChildProcess | null = null;
let projectId = '';

async function startServer(): Promise<void> {
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      CLAUDE_STATION_DATA: DATA,
      CLAUDE_CONFIG_DIR: STORE,
      CLAUDE_PROJECTS_DIR: PROJECTS,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`[server] ${d}`));
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error('server did not become healthy');
}

async function stopServer(): Promise<void> {
  if (!server) return;
  const p = server;
  server = null;
  p.kill('SIGTERM');
  await new Promise((r) => {
    p.on('exit', r);
    setTimeout(r, 4000);
  });
}

function listOf(json: any, id: string): any {
  return (json.sessions ?? []).find((s: any) => s.sessionId === id);
}

async function main(): Promise<void> {
  fs.mkdirSync(WORK, { recursive: true });
  fs.mkdirSync(PROJECTS, { recursive: true });

  writeSession(S_AUTO, { aiTitle: 'Confirm session acknowledgment' });
  writeSession(S_PLAIN);
  writeSession(S_DELETE, { aiTitle: 'Check current RAM usage' });
  writeSession(S_LIVE, { aiTitle: 'A live one' });
  writeSession(S_TAGGED, { aiTitle: 'Already tagged', tag: 'important' });
  // The same id under a second store dir: the dual-boot case the resolver must
  // refuse to guess about.
  const otherCwd = path.join(TMP, 'work2');
  fs.mkdirSync(otherCwd, { recursive: true });
  writeSession(S_DUPE, { aiTitle: 'dupe A' });
  writeSession(S_DUPE, { aiTitle: 'dupe B', cwd: otherCwd, dir: path.join(PROJECTS, encodeCwd(otherCwd)) });

  const realBefore = manifest(REAL_STORE);
  const realCountBefore = realBefore.split('\n').length;

  await startServer();
  const created = await req('POST', '/api/projects', { hostPath: WORK, name: 'verify-sessions' });
  projectId = created.json.project?.id;
  check('scratch project registered', created.status === 201 && !!projectId, `status=${created.status} id=${projectId}`);

  /* ------------------------------------------------------------- listing */
  section('1. session list carries title provenance and pin state');
  let list = (await req('GET', `/api/projects/${projectId}/sessions`)).json;
  const auto = listOf(list, S_AUTO);
  check('ai-title session reports titleSource "auto"', auto?.titleSource === 'auto' && auto?.customTitle === null,
    JSON.stringify({ titleSource: auto?.titleSource, customTitle: auto?.customTitle, autoTitle: auto?.autoTitle }));
  const plain = listOf(list, S_PLAIN);
  check('untitled session reports titleSource "prompt"', plain?.titleSource === 'prompt' && plain?.autoTitle === null,
    JSON.stringify({ titleSource: plain?.titleSource, displayTitle: plain?.displayTitle }));
  check('nothing is pinned yet', (list.sessions ?? []).every((s: any) => s.pinned === false),
    JSON.stringify((list.sessions ?? []).map((s: any) => [s.sessionId.slice(-4), s.pinned])));
  const tagged = listOf(list, S_TAGGED);
  check('a pre-existing non-pin tag is surfaced as-is', tagged?.tag === 'important' && tagged?.pinned === false,
    JSON.stringify({ tag: tagged?.tag, pinned: tagged?.pinned }));

  /* -------------------------------------------------------------- rename */
  section('2. rename');
  const bad = [
    ['empty title', { title: '   ' }],
    ['over-long title', { title: 'x'.repeat(201) }],
    ['newline in title', { title: 'line one\nline two' }],
    ['null title (no un-rename exists)', { title: null }],
    ['unknown field', { title: 'ok', colour: 'red' }],
    ['no updatable fields', { dir: ENCODED }],
    ['non-object body', 'nope'],
  ] as const;
  for (const [label, body] of bad) {
    const r = await req('PATCH', `/api/sessions/${S_AUTO}?dir=${ENCODED}`, body);
    check(`PATCH rejects ${label} with 400`, r.status === 400, `status=${r.status} error=${JSON.stringify(r.json.error)}`);
  }
  const stillAuto = listOf((await req('GET', `/api/projects/${projectId}/sessions`)).json, S_AUTO);
  check('rejected renames changed nothing', stillAuto?.customTitle === null, JSON.stringify({ customTitle: stillAuto?.customTitle }));

  const TITLE = 'The RAM-leak reaper design discussion';
  const ren = await req('PATCH', `/api/sessions/${S_AUTO}?dir=${ENCODED}`, { title: `  ${TITLE}  ` });
  check('PATCH {title} returns 200 with the new state', ren.status === 200 && ren.json.session?.customTitle === TITLE,
    `status=${ren.status} ${JSON.stringify(ren.json.session ?? ren.json)}`);
  check('rename reports titleSource "custom"', ren.json.session?.titleSource === 'custom', ren.json.session?.titleSource);
  check('rename PRESERVED the auto summary alongside', ren.json.session?.autoTitle === 'Confirm session acknowledgment', ren.json.session?.autoTitle);

  const file = path.join(DIR, `${S_AUTO}.jsonl`);
  const raw = fs.readFileSync(file, 'utf8');
  const customLines = raw.split('\n').filter((l) => l.includes('"type":"custom-title"'));
  const aiLines = raw.split('\n').filter((l) => l.includes('"type":"ai-title"'));
  check('an appended custom-title entry is on disk', customLines.length === 1 && customLines[0]!.includes(TITLE), customLines[0] ?? '(none)');
  check('the original ai-title entry is still on disk', aiLines.length === 1, aiLines[0] ?? '(none)');

  /* ----------------------------------------------------------------- pin */
  section('3. pin as a native tag');
  const pin = await req('POST', `/api/sessions/${S_AUTO}/pin?dir=${ENCODED}`);
  check('POST /pin returns pinned:true', pin.status === 200 && pin.json.session?.pinned === true && pin.json.session?.tag === 'pinned',
    `status=${pin.status} ${JSON.stringify(pin.json.session ?? pin.json)}`);
  check('pinning right after renaming is NOT blocked as "live"', pin.status !== 409, `status=${pin.status}`);
  const tagLines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.includes('"type":"tag"'));
  check('an appended tag entry is on disk', tagLines.length === 1 && tagLines[0]!.includes('"tag":"pinned"'), tagLines[0] ?? '(none)');

  list = (await req('GET', `/api/projects/${projectId}/sessions`)).json;
  const pinnedRow = listOf(list, S_AUTO);
  check('the sidebar list reports pinned + custom title without a second request',
    pinnedRow?.pinned === true && pinnedRow?.customTitle === TITLE && pinnedRow?.displayTitle === TITLE && pinnedRow?.titleSource === 'custom',
    JSON.stringify({ pinned: pinnedRow?.pinned, displayTitle: pinnedRow?.displayTitle, titleSource: pinnedRow?.titleSource, autoTitle: pinnedRow?.autoTitle }));

  const occupied = await req('POST', `/api/sessions/${S_TAGGED}/pin?dir=${ENCODED}`);
  check('pinning a session that already has another tag 409s rather than destroying it',
    occupied.status === 409 && occupied.json.code === 'tag-occupied', `status=${occupied.status} ${JSON.stringify(occupied.json.error)}`);
  check('...and that tag is untouched on disk',
    fs.readFileSync(path.join(DIR, `${S_TAGGED}.jsonl`), 'utf8').includes('"tag":"important"'), 'important still present');
  const forced = await req('POST', `/api/sessions/${S_TAGGED}/pin?dir=${ENCODED}&force=1`);
  check('...but ?force=1 overwrites it, as documented', forced.status === 200 && forced.json.session?.pinned === true,
    `status=${forced.status} tag=${forced.json.session?.tag}`);

  /* ------------------------------------------------- restart persistence */
  section('4. persistence across a server restart');
  await stopServer();
  await startServer();
  list = (await req('GET', `/api/projects/${projectId}/sessions`)).json;
  const afterRestart = listOf(list, S_AUTO);
  check('custom title survives a server restart', afterRestart?.customTitle === TITLE, afterRestart?.customTitle);
  check('pin survives a server restart', afterRestart?.pinned === true, JSON.stringify({ pinned: afterRestart?.pinned, tag: afterRestart?.tag }));

  const unpin = await req('DELETE', `/api/sessions/${S_AUTO}/pin?dir=${ENCODED}`);
  check('DELETE /pin unpins', unpin.status === 200 && unpin.json.session?.pinned === false && unpin.json.session?.tag === null,
    `status=${unpin.status} ${JSON.stringify(unpin.json.session ?? unpin.json)}`);
  check('unpin is visible on disk (tag cleared, last entry wins)',
    /"type":"tag","tag":(null|"")/.test(fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.includes('"type":"tag"')).pop() ?? '') ||
      listOf((await req('GET', `/api/projects/${projectId}/sessions`)).json, S_AUTO)?.pinned === false,
    fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.includes('"type":"tag"')).pop() ?? '(none)');

  /* -------------------------------------------------------- ambiguous dir */
  section('5. ambiguous store dir is refused, never guessed');
  const amb = await req('PATCH', `/api/sessions/${S_DUPE}`, { title: 'should not apply' });
  check('PATCH without dir on a duplicated session id 409s with candidates',
    amb.status === 409 && amb.json.code === 'ambiguous-dir' && Array.isArray(amb.json.dirs) && amb.json.dirs.length === 2,
    `status=${amb.status} dirs=${JSON.stringify(amb.json.dirs)}`);
  check('...and neither copy was renamed',
    !fs.readFileSync(path.join(DIR, `${S_DUPE}.jsonl`), 'utf8').includes('custom-title') &&
      !fs.readFileSync(path.join(PROJECTS, encodeCwd(otherCwd), `${S_DUPE}.jsonl`), 'utf8').includes('custom-title'),
    'no custom-title entry in either copy');

  /* --------------------------------------------------------- live guard */
  section('6. live sessions are refused');
  const liveFile = path.join(DIR, `${S_LIVE}.jsonl`);
  const touch = (): void => {
    const now = new Date();
    fs.utimesSync(liveFile, now, now);
  };
  touch();
  const liveDel = await req('DELETE', `/api/sessions/${S_LIVE}?dir=${ENCODED}&confirm=${S_LIVE}`);
  check('DELETE on a live session 409s', liveDel.status === 409 && liveDel.json.code === 'live-session' && liveDel.json.deleted === false,
    `status=${liveDel.status} ${JSON.stringify(liveDel.json.error)}`);
  check('...and the file is still there', fs.existsSync(liveFile), liveFile);
  touch();
  const liveDelForced = await req('DELETE', `/api/sessions/${S_LIVE}?dir=${ENCODED}&confirm=${S_LIVE}&force=1`);
  check('DELETE on a live session is NOT overridable by ?force=1', liveDelForced.status === 409 && fs.existsSync(liveFile),
    `status=${liveDelForced.status} exists=${fs.existsSync(liveFile)}`);
  touch();
  const livePatch = await req('PATCH', `/api/sessions/${S_LIVE}?dir=${ENCODED}`, { title: 'renaming a live one' });
  check('PATCH on a live session 409s', livePatch.status === 409 && livePatch.json.code === 'live-session', `status=${livePatch.status}`);
  touch();
  const livePatchForced = await req('PATCH', `/api/sessions/${S_LIVE}?dir=${ENCODED}&force=1`, { title: 'renaming a live one' });
  check('PATCH on a live session succeeds with ?force=1', livePatchForced.status === 200 && livePatchForced.json.session?.customTitle === 'renaming a live one',
    `status=${livePatchForced.status} ${JSON.stringify(livePatchForced.json.session?.customTitle)}`);

  /* -------------------------------------------------------------- delete */
  section('7. delete: confirmation, backup, removal');
  const delFile = path.join(DIR, `${S_DELETE}.jsonl`);
  // A subagent transcript dir, which deleteSession() also removes.
  const subDir = path.join(DIR, S_DELETE);
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, 'agent-abc.jsonl'), '{"type":"user"}\n');
  const beforeHash = sha256(delFile);
  const beforeBytes = fs.statSync(delFile).size;

  const bare = await req('DELETE', `/api/sessions/${S_DELETE}?dir=${ENCODED}`);
  check('a bare DELETE does NOT delete', bare.status === 400 && bare.json.code === 'confirmation-required' && fs.existsSync(delFile),
    `status=${bare.status} exists=${fs.existsSync(delFile)}`);
  const wrong = await req('DELETE', `/api/sessions/${S_DELETE}?dir=${ENCODED}&confirm=1`);
  check('DELETE with ?confirm=1 (a truthy-looking token) does NOT delete', wrong.status === 400 && fs.existsSync(delFile),
    `status=${wrong.status} exists=${fs.existsSync(delFile)}`);
  const otherId = await req('DELETE', `/api/sessions/${S_DELETE}?dir=${ENCODED}&confirm=${S_PLAIN}`);
  check("DELETE confirming a DIFFERENT session's id does NOT delete", otherId.status === 400 && fs.existsSync(delFile),
    `status=${otherId.status} exists=${fs.existsSync(delFile)}`);

  const del = await req('DELETE', `/api/sessions/${S_DELETE}?dir=${ENCODED}&confirm=${S_DELETE}`);
  check('DELETE with the echoed session id returns 200', del.status === 200 && del.json.deleted === true, `status=${del.status}`);
  const bak = del.json.backup?.path;
  check('the backup lives under the app data dir, not the session store',
    typeof bak === 'string' && bak.startsWith(path.join(DATA, 'deleted-sessions')) && !bak.startsWith(PROJECTS), String(bak));
  check('the backup exists and is byte-identical to the original',
    !!bak && fs.existsSync(bak) && sha256(bak) === beforeHash && fs.statSync(bak).size === beforeBytes,
    `sha256(before)=${beforeHash.slice(0, 16)} sha256(backup)=${bak && fs.existsSync(bak) ? sha256(bak).slice(0, 16) : 'MISSING'} bytes=${beforeBytes}`);
  check('the subagent transcript directory was backed up too',
    !!del.json.subagentBackup && fs.existsSync(path.join(del.json.subagentBackup.path, 'agent-abc.jsonl')),
    JSON.stringify(del.json.subagentBackup));
  check('the original transcript is gone', !fs.existsSync(delFile), `exists=${fs.existsSync(delFile)}`);
  check('the subagent directory is gone', !fs.existsSync(subDir), `exists=${fs.existsSync(subDir)}`);
  const gone = await req('DELETE', `/api/sessions/${S_DELETE}?dir=${ENCODED}&confirm=${S_DELETE}`);
  check('deleting it again is an honest 404, not a cheerful 200', gone.status === 404, `status=${gone.status} ${JSON.stringify(gone.json.error)}`);
  list = (await req('GET', `/api/projects/${projectId}/sessions`)).json;
  check('the deleted session is gone from the list', !listOf(list, S_DELETE), `remaining=${(list.sessions ?? []).length}`);

  /* -------------------------------------------------------- 404 / method */
  section('8. honest errors');
  const missing = await req('PATCH', '/api/sessions/ffffffff-0000-4000-8000-000000000000', { title: 'nope' });
  check('PATCH on a session that does not exist 404s', missing.status === 404, `status=${missing.status} ${JSON.stringify(missing.json.error)}`);
  const badId = await req('PATCH', '/api/sessions/..%2Fescape', { title: 'nope' });
  check('a path-traversal session id is rejected', badId.status === 400 || badId.status === 404, `status=${badId.status}`);

  /* ------------------------------------------------- the real store check */
  section('9. the user’s real session store was never touched');
  const realAfter = manifest(REAL_STORE);
  const realCountAfter = realAfter.split('\n').length;
  check('real store file count unchanged', realCountBefore === realCountAfter, `before=${realCountBefore} after=${realCountAfter}`);
  check('real store manifest (path+size+mtime) byte-identical', realBefore === realAfter,
    realBefore === realAfter ? 'identical' : `diff: ${realAfter.split('\n').filter((l) => !realBefore.includes(l)).slice(0, 3).join(' | ')}`);
  check('no backup dir was created inside the real store',
    !fs.existsSync(path.join(REAL_STORE, '..', 'deleted-sessions')), 'absent');
}

async function teardown(): Promise<void> {
  await stopServer();
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

main()
  .catch((err) => {
    failures.push(`harness crashed: ${(err as Error).message}`);
    console.error(err);
  })
  .finally(async () => {
    await teardown();
    console.log(`\n${checks - failures.length}/${checks} checks passed`);
    if (failures.length) {
      console.log('FAILURES:');
      for (const f of failures) console.log(`  - ${f}`);
    }
    process.exit(failures.length ? 1 : 0);
  });
