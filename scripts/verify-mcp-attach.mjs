/**
 * BUG-035 — an attached MCP tool server must actually start, and when it does
 * NOT the session must SAY SO (never silently run without the tools the user
 * switched on).
 *
 *   node scripts/verify-mcp-attach.mjs
 *
 * Five layers, all against real code (WORKING_AGREEMENT §C, non-vacuous):
 *
 *  A. THE CAUSE — `plannedMcpServers`/`serenaMcpServerFor` (src/server/tools.ts,
 *     the exact function AgentSession's constructor calls) must give a
 *     CONTAINER project the container's own workspace path, not a host path
 *     that does not exist in there; and the image must ship the binary Serena's
 *     command IS. Pre-fix: Serena was handed `project.hostPath` for every
 *     isolation and the image had no uv at all — both checks FAIL.
 *     BUG-107 tightened this: the command is no longer `uvx --from git+…`
 *     (a mutable git HEAD fetched at every session start) but the pinned
 *     install baked into the image / provisioned on the host.
 *
 *  B. THE HONESTY SEAM at the runtime — the REAL
 *     `ClaudeRuntime.classifyProviderError` against `system:init` frames
 *     captured from a LIVE `claude` CLI run (one with a bogus MCP command, one
 *     with the real Serena). Pre-fix: `mcp_servers` was never read anywhere in
 *     this codebase, so the failed frame classifies null — FAIL.
 *
 *  C. HEALTHY, END-TO-END through the real station: a real session on a real
 *     scratch project must actually HAVE Serena's tools at runtime (they are
 *     listed in the output).
 *
 *  D. INDUCED FAILURE, END-TO-END: a scratch station where NEITHER Serena nor
 *     Playwright has been provisioned (BUG-107/108 — the one case where "never
 *     fetch at session start" costs a capability). The user must receive an
 *     attributed `provider-error` that names EACH failed server SEPARATELY with
 *     its own exact provisioned command, and the turn must still work. BUG-108:
 *     Playwright is no longer `npx @latest` (a session-start fetch) but a pinned
 *     provisioned binary too, so the report's precision is proved by per-server
 *     attribution rather than by one server staying up. Pre-fix: the session ran
 *     silently without the tools and no event was ever emitted — FAIL.
 *
 *  E. UI RENDER — the new kind renders as an attributed card through the real
 *     client event contract (window.__station.onEvent), and — unlike a real
 *     provider failure — does NOT mislabel the turn or the session status
 *     (a missing tool is a capability loss, not this turn's error).
 *
 * Scratch ports + scratch data dirs, kill by pid; :4317 is never touched.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
const BRAVE = process.env.VERIFY_ROUTING_BROWSER ?? 'brave';
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-mcp-chrome-'));
const cleanupDirs = [PROFILE];

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

/* ============================ A. the cause ============================ */

async function partA() {
  console.log('\n=== A. the attach plan itself (src/server/tools.ts) + the image it has to run in ===');
  const { plannedMcpServers, serenaMcpServerFor, SERENA_SERVER_NAME } =
    await import(path.join(ROOT, 'src', 'server', 'tools.ts'));
  const proj = (over) => ({
    id: 'proj-a', name: 'A', hostPath: '/home/someone/projects/proj-a',
    isolation: 'direct', settings: {}, createdAt: '', updatedAt: '', ...over,
  });

  const direct = serenaMcpServerFor(proj());
  const dProject = direct.args[direct.args.indexOf('--project') + 1];
  check('(A1) direct isolation still points Serena at the host checkout (no regression)',
    dProject === '/home/someone/projects/proj-a', dProject);

  const cont = serenaMcpServerFor(proj({ isolation: 'container' }));
  const cProject = cont.args[cont.args.indexOf('--project') + 1];
  check('(A2) container isolation points Serena at the CONTAINER workspace, not the host path that does not exist in there',
    cProject === '/workspace/proj-a', cProject);

  // The plan is what a launched session actually receives — assert through it too.
  const plan = plannedMcpServers(proj({ isolation: 'container' }));
  const planned = plan.servers[SERENA_SERVER_NAME];
  check('(A3) the launched plan carries the container-shaped Serena command',
    planned?.command === '/usr/local/bin/serena' && planned.args.includes('/workspace/proj-a')
      && !planned.args.includes('/home/someone/projects/proj-a'),
    { command: planned?.command, project: planned?.args?.[planned.args.indexOf('--project') + 1] });

  /*
   * BUG-107 — this used to assert only that the image ships `uvx`, because the
   * command WAS `uvx --from git+…`: a mutable git HEAD fetched over the network
   * inside the container at every session start. The command is now the
   * pinned install itself, so the image must BAKE it, and the assertion gets
   * correspondingly stronger — uv present AND the pinned package installed AND
   * no git ref anywhere in the definition.
   */
  const dockerfile = fs.readFileSync(path.join(ROOT, 'src', 'server', 'container', 'Dockerfile'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'server', 'container', 'provision.json'), 'utf8'));
  // Comments are stripped before the git-ref check: the Dockerfile documents the
  // old `git+…` command it replaced, and that history is worth keeping. What
  // must not contain a git ref is anything the builder EXECUTES.
  const dockerfileCode = dockerfile.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  check('(A4) the container image BAKES the pinned Serena (not a session-start fetch of a git HEAD)',
    /astral\.sh\/uv\/install\.sh/.test(dockerfile) && /uv tool install/.test(dockerfileCode)
      && /provision\.json/.test(dockerfileCode) && !/git\+/.test(dockerfileCode)
      && manifest.tools.serena.package === 'serena-agent' && /^\d+\.\d+\.\d+$/.test(manifest.tools.serena.version),
    `pin=${manifest.tools.serena.package}==${manifest.tools.serena.version}; `
      + (dockerfile.split('\n').filter((l) => /uv tool install|provision\.json/.test(l)).join(' / ') || '(no install line)'));
}

/* ================= B. the honesty seam, on REAL CLI frames ================= */

/** Run the real `claude` CLI once and return its `system:init` frame. */
function initFrameWith(mcpServers, extraEnv = {}) {
  const r = spawnSync('claude', [
    '-p', 'say ok', '--output-format', 'stream-json', '--verbose',
    '--model', 'haiku', '--strict-mcp-config',
    '--mcp-config', JSON.stringify({ mcpServers }),
  ], {
    cwd: fixtureRepo, encoding: 'utf8', timeout: 300_000,
    env: { ...process.env, ...extraEnv },
  });
  for (const line of String(r.stdout ?? '').trim().split('\n')) {
    try {
      const m = JSON.parse(line);
      if (m.type === 'system' && m.subtype === 'init') return m;
    } catch { /* not a frame */ }
  }
  throw new Error(`no init frame from the CLI: ${String(r.stderr ?? '').slice(0, 400)}`);
}

let fixtureRepo = '';
function makeFixtureRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'index.ts'), 'export function greet(who: string) { return `hi ${who}`; }\n');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"bug035-fixture","private":true}\n');
  return dir;
}

async function partB() {
  console.log('\n=== B. ClaudeRuntime.classifyProviderError on REAL system:init frames ===');
  const { ClaudeRuntime } = await import(path.join(ROOT, 'src', 'server', 'runtime', 'claude-runtime.ts'));
  const { hostSerenaBin } = await import(path.join(ROOT, 'src', 'server', 'provisioning.ts'));
  const rt = new ClaudeRuntime();
  if (typeof rt.classifyProviderError !== 'function') {
    check('(B) ClaudeRuntime implements classifyProviderError', false, 'method missing');
    return;
  }

  const bogus = { serena: { type: 'stdio', command: 'uvx-not-installed-bug035', args: ['x'], env: {} } };
  const badInit = initFrameWith(bogus);
  check('(B0) GROUND TRUTH: the real CLI does not fail, does not warn on stderr — it only marks the server "failed" in system:init',
    Array.isArray(badInit.mcp_servers) && badInit.mcp_servers.some((s) => s.name === 'serena' && s.status === 'failed')
      && !badInit.tools.some((t) => String(t).startsWith('mcp__serena__')),
    { mcp_servers: badInit.mcp_servers, serenaTools: badInit.tools.filter((t) => String(t).startsWith('mcp__')) });

  // Classify the REAL frame. (The command-naming half of the detail needs a
  // started runtime — that path is covered end-to-end, against a real launched
  // session, by check D2.)
  const eBad = rt.classifyProviderError(badInit);
  check('(B1) a failed MCP server in a REAL init frame classifies as tooling-unavailable, naming the server and the tools the session lost',
    eBad?.kind === 'tooling-unavailable' && eBad?.retryable === false && eBad?.provider === 'anthropic'
      && /serena/.test(String(eBad?.detail)) && /mcp__serena__\*/.test(String(eBad?.detail)),
    eBad);

  // BUG-107 — mirror what the station now really launches: the provisioned
  // binary, not a git fetch. A fixture that still said `uvx --from git+…` would
  // be testing a command this codebase no longer emits.
  const realSerena = {
    serena: {
      type: 'stdio', command: hostSerenaBin(),
      args: ['start-mcp-server',
        '--context', 'claude-code', '--project', fixtureRepo,
        '--enable-web-dashboard', 'false', '--open-web-dashboard', 'false'],
      env: {},
    },
  };
  const goodInit = initFrameWith(realSerena);
  const eGood = rt.classifyProviderError(goodInit);
  check('(B2) NON-VACUITY: a REAL init frame whose Serena connected classifies null (no false alarm)',
    eGood === null && goodInit.mcp_servers.every((s) => s.status === 'connected'),
    { classified: eGood, mcp_servers: goodInit.mcp_servers });
}

/* ===================== station plumbing (C + D + E) ===================== */

const servers = [];
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

/**
 * BUG-107 — `provisioned` links the REAL host provisioning directory into this
 * scratch station's data dir. Serena is no longer fetched at session start; it
 * is executed from `dataDir()/provision/bin`, so a scratch data dir is by
 * definition an UNPROVISIONED host. That is a genuine state (it is what every
 * user has before their first provision), and it is now what part D induces —
 * but part C is about the healthy path and has to be given the install a
 * provisioned user has. Linking rather than re-installing keeps the suite off
 * the network, which is the property under test.
 */
/**
 * Link the REAL host provisioning into a scratch station's data dir.
 *   'both'        — the whole real provision dir (serena AND playwright present).
 *   'serena-only' — serena present, playwright DELIBERATELY absent, so a session
 *                   proves SELECTIVE degradation: one tool operational at runtime
 *                   while the other is unprovisioned (Finding 2 — restored as a
 *                   real behavioural check, not an error-string match).
 */
function linkProvision(data, mode) {
  const real = path.join(os.homedir(), '.local', 'share', 'claude-station', 'provision');
  const realSerena = path.join(real, 'bin', 'serena');
  if (!fs.existsSync(realSerena)) {
    throw new Error(`this host has no provisioned Serena at ${real}. Run \`node scripts/provision-tools.mjs --install\` once (BUG-107: a session never fetches it).`);
  }
  if (mode === 'both') {
    fs.symlinkSync(real, path.join(data, 'provision'));
    return;
  }
  if (mode === 'serena-only') {
    const pdir = path.join(data, 'provision');
    fs.mkdirSync(path.join(pdir, 'bin'), { recursive: true });
    // Resolve to the absolute entrypoint so the symlink works from the scratch
    // dir; playwright's bin is simply never created here.
    fs.symlinkSync(fs.realpathSync(realSerena), path.join(pdir, 'bin', 'serena'));
    const realRec = JSON.parse(fs.readFileSync(path.join(real, 'installed.json'), 'utf8'));
    fs.writeFileSync(path.join(pdir, 'installed.json'),
      JSON.stringify({ tools: { serena: { ...realRec.tools.serena, bin: path.join(pdir, 'bin', 'serena') } } }, null, 2) + '\n');
    return;
  }
  throw new Error(`linkProvision: unknown mode ${mode}`);
}

async function startStation(env = {}, { provisioned = false, provision } = {}) {
  const port = await freePort();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-mcp-data-'));
  cleanupDirs.push(data);
  // `provisioned: true` is the old both-tools link; `provision` is the explicit
  // mode ('both' | 'serena-only' | 'none') used by the selective-degradation part.
  const mode = provision ?? (provisioned ? 'both' : 'none');
  if (mode !== 'none') linkProvision(data, mode);
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), CLAUDE_STATION_DATA: data, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.on('data', (d) => { if (process.env.VERBOSE) process.stderr.write(`  [server!] ${d}`); });
  servers.push(child);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    try { await fetch(`${base}/api/health`); return { base, port, data }; } catch { await sleep(250); }
  }
  throw new Error('scratch server never became healthy');
}

async function addProject(base, hostPath, name, patch) {
  const reg = await (await fetch(`${base}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath, name }),
  })).json();
  if (!reg.project?.id) throw new Error(`register failed: ${JSON.stringify(reg)}`);
  cleanupDirs.push(path.join(os.homedir(), '.claude', 'projects', hostPath.replace(/[^a-zA-Z0-9]/g, '-')));
  if (patch) {
    await fetch(`${base}/api/projects/${reg.project.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
  }
  return reg.project.id;
}

/**
 * Run a real session of N turns through the real bridge and collect every
 * event. TWO turns matter here: the CLI does not wait for its MCP servers
 * before turn one (probed — see claude-runtime's classifier note), so the
 * runtime tool surface is only fully known from the SECOND `session-init`.
 */
async function liveSession(port, projectId, prompts, timeoutMs = 300_000) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const events = [];
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (d) => { try { events.push(JSON.parse(String(d))); } catch { /* noise */ } });
  const t0 = Date.now();
  for (let i = 0; i < prompts.length; i++) {
    if (i === 0) ws.send(JSON.stringify({ type: 'start', projectId, prompt: prompts[i] }));
    else {
      // Give a healthy server its (short) startup window before turn two.
      await sleep(20_000);
      ws.send(JSON.stringify({ type: 'send', prompt: prompts[i] }));
    }
    while (Date.now() - t0 < timeoutMs) {
      if (events.filter((e) => e.t === 'turn-end').length > i) break;
      if (events.some((e) => e.t === 'error' && e.fatal)) break;
      await sleep(200);
    }
  }
  try { ws.send(JSON.stringify({ type: 'close' })); } catch { /* gone */ }
  await sleep(300);
  try { ws.close(); } catch { /* gone */ }
  return events;
}

async function partC(repo) {
  console.log('\n=== C. HEALTHY: a real station session on a real scratch project HAS Serena at runtime ===');
  const { base, port } = await startStation({}, { provisioned: true });
  const projectId = await addProject(base, repo, 'bug035-healthy', { model: 'haiku', permissionMode: 'bypassPermissions' });
  const events = await liveSession(port, projectId, [
    'Reply with exactly the word: ok',
    'Reply with exactly the word: ok',
  ]);
  const inits = events.filter((e) => e.t === 'session-init');
  const serenaTools = (inits.at(-1)?.tools ?? []).filter((t) => String(t).startsWith('mcp__serena__'));
  check('(C1) the launched session really exposes Serena\'s symbol tools at runtime (default-on toggle → real tools)',
    serenaTools.length >= 15 && serenaTools.includes('mcp__serena__find_symbol')
      && serenaTools.includes('mcp__serena__find_referencing_symbols'),
    serenaTools.join(', ') || '(none)');
  const pes = events.filter((e) => e.t === 'provider-error' && e.kind === 'tooling-unavailable');
  check('(C2) a healthy attach NEVER reports a failure — at most the honest "still starting" notice, and never after it connects',
    pes.every((e) => e.pending === true), pes.map((e) => ({ pending: e.pending, detail: e.detail })));
  /*
   * FEAT-055 changed this contract: the runtime now HOLDS the first prompt
   * (bounded, CLAUDE_STATION_MCP_READY_TIMEOUT_MS) until the MCP servers leave
   * `pending`, so on a healthy attach turn ONE normally already has Serena and
   * NO notice fires. The old turn-one gap is only legitimate when the bounded
   * wait ran out — and then it must still be said out loud.
   */
  const firstInitSerena = (inits[0]?.tools ?? []).some((t) => String(t).startsWith('mcp__serena__'));
  check('(C3) turn ONE either really has Serena (FEAT-055 readiness gate) or the gap is SAID OUT LOUD — never a silent toolless turn',
    firstInitSerena || pes.some((e) => e.pending === true && /serena/.test(String(e.detail))),
    firstInitSerena ? 'first session-init already lists mcp__serena__* tools'
      : (pes.find((e) => e.pending)?.detail ?? '(no serena on turn one AND no attaching notice)'));
  check('(C4) both turns completed normally',
    events.filter((e) => e.t === 'turn-end').length === 2,
    events.filter((e) => e.t === 'turn-end').map((e) => e.subtype));
  return { base, port, projectId };
}

async function partD(repo) {
  console.log('\n=== D. INDUCED FAILURE: Serena not provisioned — the user must be TOLD, not silently deprived ===');
  /*
   * BUG-107 changed what "Serena cannot start" LOOKS like, so the induction
   * follows. It used to be a PATH stripped of `uvx` — a stand-in for the real
   * container bug (node present, uv absent). Now the command is an absolute
   * provisioned binary, so the honest, no-stand-in-needed induction is a station
   * whose host install has not been provisioned yet: exactly the state every
   * user is in before their first provision, and the one case where the new
   * "never fetch at session start" rule costs a capability. It must be SAID.
   *
   * BUG-108 UPDATE (sanctioned edit to a BUG-107 assertion — flagged in the
   * report): Playwright USED to be `npx -y @playwright/mcp@latest`, so this part
   * relied on it staying attached (a network fetch at session start) to prove
   * the failure report was selective. That auto-fetch is exactly what BUG-108
   * removed: Playwright is now ALSO a pinned, provisioned binary, so in an
   * unprovisioned scratch station BOTH servers legitimately fail. The selectivity
   * property is re-proved a STRONGER way — the report must attribute EACH failed
   * server SEPARATELY with its own exact provisioned command (serena AND
   * playwright), not collapse to a blanket "MCP is down"; and part C still proves
   * a provisioned Serena genuinely attaches, so the C-vs-D contrast is the
   * positive/negative control. A positive end-to-end proof that the pinned
   * Playwright starts and lists tools lives in verify-bug-108-playwright-pin.mjs.
   */
  const { base, port, data } = await startStation();
  const missingSerena = path.join(data, 'provision', 'bin', 'serena');
  const missingPlaywright = path.join(data, 'provision', 'bin', 'playwright-mcp');
  check('(D0) precondition: this scratch station has NEITHER a provisioned Serena NOR Playwright binary',
    !fs.existsSync(missingSerena) && !fs.existsSync(missingPlaywright),
    `${missingSerena} absent; ${missingPlaywright} absent`);
  const projectId = await addProject(base, repo, 'bug035-broken', {
    model: 'haiku', permissionMode: 'bypassPermissions',
    tools: { serena: true, playwright: true },
  });
  const events = await liveSession(port, projectId, [
    'Reply with exactly the word: ok',
    'Reply with exactly the word: ok',
  ]);
  const tools = events.filter((e) => e.t === 'session-init').at(-1)?.tools ?? [];
  const pe = events.find((e) => e.t === 'provider-error' && e.kind === 'tooling-unavailable' && !e.pending);

  check('(D1) the session is REPORTED as running without Serena — attributed, never silent',
    !!pe && pe.retryable === false && /serena/.test(String(pe.detail)) && /mcp__serena__\*/.test(String(pe.detail)),
    pe ?? '(NO provider-error event — the silent failure this bug is about)');
  check('(D2) the report names the exact command that failed, so it is actionable',
    !!pe && new RegExp(`${data.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/provision/bin/serena start-mcp-server`).test(String(pe.detail)),
    pe?.detail);
  check('(D3) ground truth behind the report: Serena\'s tools really are absent from this session',
    tools.length > 0 && !tools.some((t) => String(t).startsWith('mcp__serena__')),
    tools.filter((t) => String(t).startsWith('mcp__')).join(', ') || '(no mcp tools at all)');
  // BUG-108 — precise, per-server attribution (replaces the old "npx Playwright
  // stayed up" selectivity check): the report must name Playwright SEPARATELY,
  // with its own exact provisioned command, and Playwright's tools must likewise
  // be absent — the failure is enumerated, not blanket.
  check('(D4) SELECTIVE ATTRIBUTION: the report names Playwright too, with ITS exact provisioned command, and lists its lost tools',
    !!pe && new RegExp(`${missingPlaywright.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|"|$)`).test(String(pe.detail))
      && /mcp__playwright__\*/.test(String(pe.detail)),
    pe?.detail);
  check('(D4b) ground truth: Playwright\'s tools really are absent too (no session-start fetch resurrected it)',
    !tools.some((t) => String(t).startsWith('mcp__playwright__')),
    tools.filter((t) => String(t).startsWith('mcp__playwright__')).join(', ') || '(no playwright tools, as expected)');
  check('(D5) the turns still ran to completion (a missing tool degrades the session, it does not kill it)',
    events.filter((e) => e.t === 'turn-end').length === 2,
    events.filter((e) => e.t === 'turn-end').map((e) => e.subtype));
}

/*
 * D(sel) — SELECTIVE DEGRADATION, proved by BEHAVIOUR (Finding 2, restored).
 *
 * The clean-room caught this lane trading a behavioural proof for a string
 * match: D4 used to show one tool STAYING OPERATIONAL while the other failed;
 * the rewrite let BOTH be absent and only checked that the report NAMED each.
 * The per-server attribution checks (D0..D5) are a genuine, stronger addition
 * and are KEPT above — but the property "one tool remains operational while the
 * other is unprovisioned" must still be OBSERVED, not inferred from an error
 * string. So: a scratch station where Serena IS provisioned and Playwright is
 * NOT. Serena's real tools must be present at runtime; Playwright's must be
 * absent; and the report must name ONLY the failed server, never claim Serena
 * failed. This is the C-vs-D positive/negative control made SELECTIVE within a
 * single session.
 */
async function partDsel(repo) {
  console.log('\n=== D(sel). SELECTIVE: Serena provisioned, Playwright NOT — one stays OPERATIONAL, only the other is reported ===');
  const { base, port, data } = await startStation({}, { provision: 'serena-only' });
  const serenaBin = path.join(data, 'provision', 'bin', 'serena');
  const missingPlaywright = path.join(data, 'provision', 'bin', 'playwright-mcp');
  check('(Dsel0) precondition: Serena IS provisioned in this scratch station, Playwright is NOT',
    fs.existsSync(serenaBin) && !fs.existsSync(missingPlaywright),
    `serena=${fs.existsSync(serenaBin)} playwright=${fs.existsSync(missingPlaywright)}`);
  const projectId = await addProject(base, repo, 'bug035-selective', {
    model: 'haiku', permissionMode: 'bypassPermissions',
    tools: { serena: true, playwright: true },
  });
  const events = await liveSession(port, projectId, [
    'Reply with exactly the word: ok',
    'Reply with exactly the word: ok',
  ]);
  const tools = events.filter((e) => e.t === 'session-init').at(-1)?.tools ?? [];
  const serenaTools = tools.filter((t) => String(t).startsWith('mcp__serena__'));
  const playwrightTools = tools.filter((t) => String(t).startsWith('mcp__playwright__'));
  const pe = events.find((e) => e.t === 'provider-error' && e.kind === 'tooling-unavailable' && !e.pending);

  check('(Dsel1) BEHAVIOURAL: Serena stays OPERATIONAL — its real symbol tools are present at runtime despite Playwright being down',
    serenaTools.length >= 15 && serenaTools.includes('mcp__serena__find_symbol')
      && serenaTools.includes('mcp__serena__find_referencing_symbols'),
    serenaTools.join(', ') || '(none — Serena did NOT stay operational)');
  check('(Dsel2) BEHAVIOURAL: the degradation is SELECTIVE — Playwright\'s tools are absent while Serena\'s are present (not a blanket both-down)',
    playwrightTools.length === 0 && serenaTools.length > 0,
    `serena=${serenaTools.length} tools, playwright=${playwrightTools.length} tools`);
  check('(Dsel3) the report names ONLY the failed server (Playwright) with its exact command, and does NOT claim Serena failed',
    !!pe && new RegExp(`${missingPlaywright.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|"|$)`).test(String(pe.detail))
      && /mcp__playwright__\*/.test(String(pe.detail)) && !/mcp__serena__/.test(String(pe.detail)),
    pe?.detail ?? '(no provider-error naming playwright)');
  check('(Dsel4) both turns completed — a partial capability loss degrades, it does not kill the session',
    events.filter((e) => e.t === 'turn-end').length === 2,
    events.filter((e) => e.t === 'turn-end').map((e) => e.subtype));
}

/* ============================ E. the UI render ============================ */

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); }
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
      await sleep(150);
    }
    console.log(`        (timed out waiting for ${label} after ${timeoutMs}ms)`);
    return false;
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

let browser = null;
async function partE(base, projectId) {
  console.log('\n=== E. UI: the report renders as an attributed card, and does NOT mislabel the turn ===');
  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 60 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: `${base}/#/project/${projectId}` });
  await cdp.waitFor('boot', 'window.__station !== undefined');

  const detail = 'MCP tool server did not start: serena (status: failed; command: /home/you/.local/share/claude-station/provision/bin/serena start-mcp-server). '
    + 'This session is running WITHOUT mcp__serena__*.';
  await cdp.eval(`(() => {
    window.__station.state.busy = true;
    window.__station.onEvent({ t: 'provider-error', kind: 'tooling-unavailable', retryable: false,
      provider: 'anthropic', detail: ${JSON.stringify(detail)} });
  })()`);
  const card = await cdp.eval(`(() => {
    const c = [...document.querySelectorAll('.provider-error')].pop();
    return c ? { kind: c.dataset.kind, head: c.querySelector('.pe-head')?.textContent,
      detail: c.querySelector('.pe-detail')?.textContent, retry: !!c.querySelector('.pe-retry'),
      busy: window.__station.state.busy, fine: document.querySelector('#fine')?.textContent } : null;
  })()`);
  check('(E1) an attributed card names the provider AND the capability that is missing, with the command verbatim',
    card?.kind === 'tooling-unavailable' && /anthropic/.test(String(card.head)) && /tools missing/i.test(String(card.head))
      && /serena/.test(String(card.detail)) && card.retry === false,
    card);
  check('(E2) busy is untouched — the turn is still alive; a missing tool is not a turn failure',
    card?.busy === true, { busy: card?.busy });

  // The turn then ends normally: it must NOT be relabelled by the tool report.
  await cdp.eval(`window.__station.onEvent({ t: 'turn-end', subtype: 'success', interrupted: false, isError: false, durationMs: 900 })`);
  const after = await cdp.eval(`({ sessError: window.__station.state.sessError,
    sessState: window.__station.computeSessState(), fine: document.querySelector('#fine')?.textContent,
    cardStillThere: document.querySelectorAll('.provider-error').length })`);
  check('(E3) a clean turn after the report still reads clean (the card is durable, but it never fakes an error turn)',
    after?.sessError === null && after?.sessState !== 'error' && after?.cardStillThere >= 1,
    after);
  await cdp.send('Page.captureScreenshot', { format: 'png' })
    .then((r) => fs.writeFileSync(path.join(ROOT, 'docs', 'bugs', 'assets', 'BUG-035-tooling-unavailable.png'), Buffer.from(r.data, 'base64')))
    .catch(() => { /* best effort */ });
  cdp.close();
}

/* =================================== main =================================== */

async function main() {
  fixtureRepo = makeFixtureRepo('cs-mcp-fixture-');
  await partA();
  await partB();
  const healthy = await partC(makeFixtureRepo('cs-mcp-healthy-'));
  await partD(makeFixtureRepo('cs-mcp-broken-'));
  await partDsel(makeFixtureRepo('cs-mcp-selective-'));
  await partE(healthy.base, healthy.projectId);

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  process.exitCode = fail ? 1 : 0;
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(async () => {
    for (const s of servers) stopByPid(s);
    stopByPid(browser);
    await sleep(500);
    for (const d of cleanupDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  });
