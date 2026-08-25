#!/usr/bin/env node
/*
 * BUG-152 — an unconfigured stealth-browser adapter must DEGRADE a session,
 * not refuse it.
 *
 * THE LIVE FAILURE. A real project (isolation: container, browser.enabled: true,
 * settings untouched for weeks) could not start a session at all:
 *
 *   stealth browser unavailable (adapter-missing): no browser adapter configured
 *   — set CLAUDE_STATION_SBMCP_REPO to a checkout of the adapter project.
 *
 * captured verbatim off the RUNNING server over its own /ws `start`. The adapter
 * checkout was present and complete on disk the whole time; what was missing was
 * the env var pointing at it, which lived only in the systemd user manager's
 * environment and was dropped by a reboot. Host configuration that has nothing
 * to do with the session being started took the entire product down for every
 * browser-enabled project.
 *
 * WHAT IS ASSERTED. Not "the message is nicer" — the three properties that
 * together make a degrade honest rather than a silent hole:
 *
 *   A. the session STARTS and the error is non-fatal
 *   B. the tools are NOT attached (a stated-unavailable browser must not also
 *      appear in the tool list — that is how it becomes a mid-task failure)
 *   C. the system prompt SAYS SO, with the reason
 *
 * plus D: an enabled-but-unavailable browser must not break container binds,
 * which is the path that actually throws (`browserBinds` -> `requireRepoDir`).
 *
 * MUST-FAIL PROOF: run against the pre-fix tree and A, B and D fail.
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

/*
 * The adapter is deliberately UNCONFIGURED for this whole run. That is the state
 * the user was in, and it is the state every assertion below is about. Set
 * before the modules are imported because `repoDir()` reads process.env at call
 * time and several of these paths resolve eagerly.
 *
 * Whatever this machine had configured is kept for the converse check in B — so
 * the suite exercises a REAL adapter checkout where one exists, without any path
 * baked into the repo.
 */
const configuredRepo = process.env.CLAUDE_STATION_SBMCP_REPO ?? '';
delete process.env.CLAUDE_STATION_SBMCP_REPO;

const bridge = await import(path.join(ROOT, 'src/server/agent-bridge.ts'));
const tools = await import(path.join(ROOT, 'src/server/tools.ts'));
const browser = await import(path.join(ROOT, 'src/server/browser.ts'));
const cm = await import(path.join(ROOT, 'src/server/container-manager.ts'));

/*
 * A REALISTIC project, copied from the shape the live registry actually holds
 * for the affected project: container isolation, browser on, playwright on, serena on,
 * openaiDispatch on, and a user mount. Not the minimal case — the minimal case
 * (browser on, nothing else) would miss that the OTHER tools must survive the
 * browser being unavailable, which is the entire point of degrading.
 */
const project = {
  id: 'bug152-fixture',
  name: 'bug152-fixture',
  hostPath: path.join(os.tmpdir(), 'bug152-fixture'),
  isolation: 'container',
  settings: {
    model: null, effort: null, maxBudgetUsd: null, permissionMode: 'default',
    allowedTools: [], disallowedTools: [],
    mounts: [{ hostPath: '/nonexistent/sibling', containerPath: '/workspace/sibling', readOnly: false }],
    instructions: [],
    container: { image: null, dockerSocket: false, memoryMb: 8192, pidsLimit: 4096 },
    browser: { enabled: true, idleMs: null },
    tools: { serena: true, playwright: true, openaiDispatch: true },
    snapshots: { enabled: null, keep: 10, exclude: [] },
    provider: 'anthropic', responseDigest: { enabled: true }, methodVersion: 1,
    orchestratorProfile: { enabled: true },
  },
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
};

console.log('=== precondition: the adapter really is unavailable ===');
const avail = browser.available();
check('browser.available() reports not-ok with the env-var message',
  !avail.ok && /CLAUDE_STATION_SBMCP_REPO/.test(avail.message), avail.message);

// ---------------------------------------------------------------- A. non-fatal
console.log('\n=== A. session start DEGRADES: the browser error is not fatal ===');
const src = fs.readFileSync(path.join(ROOT, 'src/server/agent-bridge.ts'), 'utf8');
/*
 * Read the browser block out of startSession by its landmarks rather than by
 * line number, and assert on THAT slice — a `fatal: true` somewhere else in a
 * 4000-line file (the container block below it legitimately has one) must not
 * be able to pass or fail this.
 */
const blockStart = src.indexOf('if (browserSettingsOf(opts.project).enabled) {\n    try {');
const blockEnd = src.indexOf('const dispatchUnavailableReason = await prepareDispatchForSession', blockStart);
check('the browser start block was located', blockStart > 0 && blockEnd > blockStart);
const block = src.slice(blockStart, blockEnd);
check('the browser failure path no longer marks the event fatal',
  !/fatal:\s*true/.test(block), block.match(/fatal:\s*\w+/g)?.join(', ') ?? '(no fatal key)');
check('the browser failure path no longer throws out of startSession',
  !/\bthrow new Error\(/.test(block));
check('it still emits a visible error event (degrade is not silence)',
  /t: 'error'/.test(block) && /fatal:\s*false/.test(block));
check('the reason is captured for the session rather than discarded',
  /browserUnavailableReason\s*=/.test(block));
check('the captured reason is threaded into the session',
  /browserUnavailableReason\s*\}\)/.test(src) || /dispatchUnavailableReason,\s*browserUnavailableReason/.test(src));

// ------------------------------------------------------------- B. no tools
console.log('\n=== B. an UNAVAILABLE browser is not in the tool list ===');
const degraded = tools.plannedMcpServers(project, { browserUnavailableReason: 'adapter-missing: no browser adapter configured' });
check('no mcp__stealth-browser__* server is attached when the browser is unavailable',
  !(browser.MCP_SERVER_NAME in degraded.servers), Object.keys(degraded.servers).join(', '));
check('the OTHER tools still attach — degrading the browser degrades only the browser',
  'serena' in degraded.servers && 'playwright' in degraded.servers,
  Object.keys(degraded.servers).join(', '));
check('strict MCP config is still on (the station is still the only source)', degraded.strict === true);

/*
 * The converse, so this cannot pass by simply never attaching the browser:
 * with no reason supplied and an AVAILABLE adapter the server IS attached.
 * Pointed at the real checkout if one exists on this machine, otherwise skipped
 * honestly rather than faked.
 */
if (configuredRepo && fs.existsSync(path.join(configuredRepo, 'src', 'mcp-stdio.mjs'))) {
  process.env.CLAUDE_STATION_SBMCP_REPO = configuredRepo;
  const okPlan = tools.plannedMcpServers(project);
  check('with the adapter available and no reason, the browser IS attached (converse)',
    browser.MCP_SERVER_NAME in okPlan.servers, Object.keys(okPlan.servers).join(', '));
  delete process.env.CLAUDE_STATION_SBMCP_REPO;
} else {
  console.log('  skip converse: CLAUDE_STATION_SBMCP_REPO is not set to a complete adapter checkout');
}

// --------------------------------------------------------- C. the prompt says so
console.log('\n=== C. the session is TOLD, with the reason ===');
const reason = 'adapter-missing: no browser adapter configured — set CLAUDE_STATION_SBMCP_REPO to a checkout of the adapter project.';
const note = bridge.browserAvailabilityNote(true, reason);
check('the note states enabled-but-UNAVAILABLE', /UNAVAILABLE/.test(note));
check('the note carries the actual reason, not a generic apology',
  /CLAUDE_STATION_SBMCP_REPO/.test(note), note.slice(0, 160));
check('the note does not claim the session has a browser',
  !/You have a browser/.test(note));
check('the note tells the session not to improvise a replacement',
  /Do NOT start a browser yourself/.test(note) && /do NOT kill any process/i.test(note));
/*
 * The pairing that matters most: with the stealth browser unavailable, the
 * PLAYWRIGHT note must not point at it as the alternative. Offering a toolset
 * that was not attached is the same guess-and-improvise the notes exist to stop
 * — and it is the exact fallback that put a headful window on screen in BUG-151.
 */
const pwNoPlaywright = bridge.playwrightAvailabilityNote(false, { stealthEnabled: false, inContainer: true });
check('with no Playwright and an unavailable stealth browser, the session is told it has NO browser at all',
  /no browser at all/.test(pwNoPlaywright), pwNoPlaywright.slice(0, 160));
check('and is NOT pointed at mcp__stealth-browser__ as a fallback',
  !/stealth-browser__\*/.test(pwNoPlaywright));
check('the bridge computes stealthEnabled from the reason, not just the setting',
  /stealthEnabled: stealthOn && !opts\.browserUnavailableReason/.test(src));

// ------------------------------------------------- D. container binds survive
console.log('\n=== D. an unavailable adapter does not break container binds ===');
/*
 * This is the path that actually threw: `browserBinds` resolves the MCP shim
 * through `requireRepoDir()`, so with the toggle on and no adapter, ASKING for
 * the desired binds raised BrowserError — taking down `POST /container/start`,
 * `rebuild` and the drift check, none of which have anything to do with the
 * browser. A degrading session start reaches this every time.
 */
let bindsErr = null, binds = null, exported = typeof cm.desiredBinds === 'function';
try {
  binds = exported ? cm.desiredBinds(project) : null;
} catch (err) { bindsErr = err; }
check('desiredBinds is reachable from this test (behaviour, not just source, is graded)', exported);
check('computing container binds does not throw when the adapter is unconfigured',
  exported && bindsErr === null, bindsErr ? String(bindsErr.message) : '');
check('no stealth-browser bind is present', !(binds ?? []).some((b) => /stealth browser/.test(b.why ?? '')));

// prove the throw is real, so the guard is not decoration
let threw = false;
try { browser.browserBinds(project); } catch { threw = true; }
check('browserBinds() genuinely throws when the adapter is unconfigured (the guard is load-bearing)', threw);

/*
 * THE ONE THE UNIT TESTS MISSED AND THE END-TO-END RUN CAUGHT — and the reason
 * these source checks now run unconditionally instead of as a fallback branch.
 * Guarding `desiredBinds` was not enough: `ensureContainer` had a SECOND
 * browserBinds call (the BUG-136 root-owned-dir heal) which threw on the real
 * path while every assertion here passed. The first version of this file put
 * these two checks in an `else` that never executed, so it reported 20/20 on a
 * tree that still could not start a session. Grade every call site, always.
 */
const cmSrc = fs.readFileSync(path.join(ROOT, 'src/server/container-manager.ts'), 'utf8');
check('the bind block is gated on the adapter actually being available',
  /browserSettingsOf\(project\)\.enabled && browserAvailable\(\)\.ok/.test(cmSrc));
// Comments stripped first: this file explains `browserBinds()` in prose right
// next to the code, and a mention in a comment is not a call site.
const cmCode = cmSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const bindCalls = (cmCode.match(/[^.\w]browserBinds\(/g) ?? []).length;
check('container-manager calls browserBinds() exactly once (the guarded desiredBinds block)',
  bindCalls === 1, `found ${bindCalls}`);
check('the BUG-136 socket heal is adapter-independent (socketPath, not browserBinds)',
  /const sock = browserSocketPath\(project\);/.test(cmSrc)
  && /removed a directory left at the stealth browser socket path/.test(cmSrc));

console.log(`\n${'='.repeat(60)}\n${pass} passed, ${fail} failed`);
if (fail) console.log(`failures:\n  - ${failures.join('\n  - ')}`);
process.exit(fail ? 1 : 0);
