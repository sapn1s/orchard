/**
 * FEAT-025 — per-project attachable dev-tool toggle, compose-layer verification.
 *
 *   node scripts/verify-tool-toggle.mjs
 *
 * Mirrors scripts/verify-local-conventions.mjs: exercises the REAL launch-path
 * function (`plannedMcpServers`, src/server/tools.ts) — the exact function
 * AgentSession's constructor calls and forwards verbatim into
 * RuntimeStartConfig.mcpServers — against synthetic projects. No mocks, no live
 * model, no server on :4317.
 *
 * "Attach" here means an entry in that `mcpServers` map (+ strictMcpConfig). So
 * asserting on `plannedMcpServers(project)` is asserting on the exact MCP config
 * a LAUNCHED session receives, not just a stored bool.
 *
 * MUST FAIL before the change: `src/server/tools.ts` did not exist and Serena
 * was never in the station-attached map (only the stealth browser was), so the
 * default-on Serena assertion and the toggle-off assertions had nothing to pass
 * against.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';

const ROOT = path.resolve(import.meta.dirname, '..');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}

// A minimal but real Project: plannedMcpServers only reads settings.{browser,tools}.
function project(over = {}) {
  const { isolation = 'direct', browser, tools, hostPath = '/tmp/proj-fixture' } = over;
  return {
    id: 'p-fixture', name: 'Fixture', hostPath, isolation,
    settings: { ...(browser ? { browser } : {}), ...(tools ? { tools } : {}) },
    createdAt: '', updatedAt: '',
  };
}

async function main() {
  const { plannedMcpServers, SERENA_SERVER_NAME, PLAYWRIGHT_SERVER_NAME, serenaMcpServerFor,
    playwrightMcpServerFor, CONTAINER_PLAYWRIGHT_BIN } =
    await import(path.join(ROOT, 'src', 'server', 'tools.ts'));
  const { MCP_SERVER_NAME } = await import(path.join(ROOT, 'src', 'server', 'browser.ts'));
  const { hostSerenaBin, hostPlaywrightBin } = await import(path.join(ROOT, 'src', 'server', 'provisioning.ts'));

  // --- (1) DEFAULT preserves current behaviour: Serena on, others off ---
  const def = plannedMcpServers(project());
  check('(1a) a project with NO tool settings attaches Serena by default (repo default-on preserved)',
    SERENA_SERVER_NAME in def.servers, Object.keys(def.servers));
  check('(1b) default does NOT attach Playwright (opt-in)',
    !(PLAYWRIGHT_SERVER_NAME in def.servers), Object.keys(def.servers));
  check('(1c) default does NOT attach the browser (browser stays its own opt-in)',
    !(MCP_SERVER_NAME in def.servers), Object.keys(def.servers));
  check('(1d) default is strict (station is the sole MCP source once it attaches anything)',
    def.strict === true, def.strict);

  // --- (2) Serena toggled OFF: it is NOT in the launched session's MCP config ---
  const serenaOff = plannedMcpServers(project({ tools: { serena: false, playwright: false } }));
  check('(2a) tools.serena=false → Serena is NOT attached',
    !(SERENA_SERVER_NAME in serenaOff.servers), Object.keys(serenaOff.servers));
  check('(2b) with everything off, the map is empty and strict is false (CLI keeps its own MCP discovery)',
    Object.keys(serenaOff.servers).length === 0 && serenaOff.strict === false,
    { servers: Object.keys(serenaOff.servers), strict: serenaOff.strict });

  // --- (3) Playwright toggled ON: it IS attached (non-UI project opting a UI tool in) ---
  const pwOn = plannedMcpServers(project({ tools: { serena: false, playwright: true } }));
  check('(3a) tools.playwright=true → Playwright IS attached',
    PLAYWRIGHT_SERVER_NAME in pwOn.servers, Object.keys(pwOn.servers));
  check('(3b) Serena stays OFF when only Playwright is enabled (toggles are independent)',
    !(SERENA_SERVER_NAME in pwOn.servers), Object.keys(pwOn.servers));
  check('(3c) attaching Playwright alone flips strict on',
    pwOn.strict === true, pwOn.strict);

  // --- (4) All three together compose into one map ---
  const all = plannedMcpServers(project({ browser: { enabled: true }, tools: { serena: true, playwright: true } }));
  check('(4) browser + serena + playwright all present together',
    MCP_SERVER_NAME in all.servers && SERENA_SERVER_NAME in all.servers && PLAYWRIGHT_SERVER_NAME in all.servers,
    Object.keys(all.servers));

  // --- (5) Serena command is pinned to THIS project's checkout ---
  const s = serenaMcpServerFor(project({ hostPath: '/tmp/some-other-repo' }));
  // BUG-107 — the command is no longer `uvx --from git+…` (a mutable git HEAD
  // re-resolved over the network at every session start). It is the absolute
  // path of the station-provisioned install.
  //
  // BUG-108 clean-room correction — the earlier rewrite of this assertion checked
  // only `s.command.endsWith('/serena')`, which a SUFFIX-matches an
  // attacker-controlled path like `/tmp/attacker/serena`. In a change whose whole
  // purpose is supply-chain safety, the pinned position must be an EXACT identity,
  // not a pattern. It now asserts the command equals `hostSerenaBin()` verbatim.
  const serenaExpected = hostSerenaBin();
  check('(5) serenaMcpServerFor emits EXACTLY the station-provisioned serena binary (exact identity, not a /serena suffix)',
    s.command === serenaExpected && path.isAbsolute(s.command) && !JSON.stringify(s).includes('git+')
      && s.args.includes('/tmp/some-other-repo') && s.args.includes('claude-code'),
    { command: s.command, expected: serenaExpected, project: s.args[s.args.indexOf('--project') + 1] });

  // (5b) NEGATIVE CONTROL, folded in so the loosening cannot silently return: an
  // arbitrary path that merely ends in `/serena` (what the old suffix check
  // accepted) must be REJECTED by the exact-identity predicate this suite now uses.
  const attacker = '/tmp/attacker/serena';
  check('(5b) the exact-identity check REJECTS an attacker path that only ends in /serena (old suffix check would have accepted it)',
    attacker.endsWith('/serena') && attacker !== serenaExpected,
    { attacker, endsWithSerena: attacker.endsWith('/serena'), equalsExpected: attacker === serenaExpected });

  // --- (7) Playwright command is the pinned local install, never `npx @latest` ---
  // BUG-108 — same exact-identity discipline as (5): pin the emitted command, not a pattern.
  const pwDirect = playwrightMcpServerFor(project({ isolation: 'direct', tools: { playwright: true } }));
  const pwExpected = hostPlaywrightBin();
  const noFetch = (o) => { const j = JSON.stringify(o); return !j.includes('npx') && !j.includes('@latest') && !j.includes('"-y"') && !j.includes('git+'); };
  check('(7a) direct Playwright emits EXACTLY the provisioned playwright-mcp binary — no npx, no @latest, no -y',
    pwDirect.command === pwExpected && path.isAbsolute(pwDirect.command) && noFetch(pwDirect),
    { command: pwDirect.command, expected: pwExpected, args: pwDirect.args });
  const pwCont = playwrightMcpServerFor(project({ isolation: 'container', tools: { playwright: true } }));
  check('(7b) container Playwright emits EXACTLY the baked /usr/local/bin/playwright-mcp — no session-start fetch',
    pwCont.command === CONTAINER_PLAYWRIGHT_BIN && noFetch(pwCont),
    { command: pwCont.command, expected: CONTAINER_PLAYWRIGHT_BIN, args: pwCont.args });

  // --- (6) WIRING: the launch site actually forwards plannedMcpServers ---
  const bridge = fs.readFileSync(path.join(ROOT, 'src', 'server', 'agent-bridge.ts'), 'utf8');
  check('(6a) agent-bridge.ts calls plannedMcpServers (the real launch path uses this seam)',
    /plannedMcpServers\(opts\.project\)/.test(bridge), 'call present');
  check('(6b) agent-bridge.ts forwards the plan into runtime.start via mcpServers/strictMcpConfig',
    /^\s*mcpServers,\s*$/m.test(bridge) && /strictMcpConfig:\s*strictMcpConfig/.test(bridge), 'forwarding present');

  console.log(`\n${pass}/${pass + fail} checks passed`);
  process.exitCode = fail ? 1 : 0;
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.stack ?? err.message}`);
  process.exitCode = 1;
});
