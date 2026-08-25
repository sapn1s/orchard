/**
 * BUG-151 — "a UI check used the headful stealth browser, because the headless
 * one did not work and nothing said which was which".
 *
 *   node scripts/verify-bug-151-playwright-first.mjs
 *
 * THE INCIDENT (2026-08-25, a container-isolated project).
 * Asked whether a landing page scrolled to a form, the session reached for
 * Playwright FIRST — the correct call — and got back, verbatim:
 *
 *   Error: async initializeServer: Chromium distribution 'chrome' is not found
 *   at /opt/google/chrome/chrome  Run "npx playwright install chrome"
 *
 * because the container image baked the MCP SERVER and no BROWSER, and
 * `playwrightBrowserArgs(inContainer)` returned `[]`, leaving @playwright/mcp on
 * its default `chrome` CHANNEL. It then fell back to `mcp__stealth-browser__*`,
 * which runs headful on the host, and a window appeared in the user's workspace
 * for a job that should have left no trace. Availability, not judgement.
 *
 * Two halves are proven here, and both are needed:
 *
 *   1. AVAILABILITY — the REAL container image, driven over REAL MCP stdio,
 *      completes a REAL UI check (click a link, measure the scroll it produced),
 *      headless, with no window. Section B also runs the OLD arg shape against
 *      the NEW image to prove the `--browser` argument is load-bearing rather
 *      than the image change carrying it alone.
 *   2. LEGIBILITY — a session is TOLD at launch which browser is for what, and
 *      told loudly when Playwright is ABSENT. Two browser toolsets and no
 *      guidance is a coin flip, and half of those flips interrupt the user.
 *
 * MUST FAIL before the fix: section A asserted `--browser chromium` where the
 * code returned `[]`; section B's navigate returned the error quoted above
 * (reproduced byte-for-byte against the pre-fix image before this was written);
 * section C's `playwrightAvailabilityNote` did not exist.
 *
 * Touches nothing of the user's: builds/uses a scratch-tagged image, mounts a
 * scratch fixture read-only, starts only containers it removes, and never looks
 * at port 4317, the station service, or any process it did not start.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRATCH = fs.mkdtempSync(path.join(os.homedir(), 'scratch', 'verify-bug151-'));
const IMAGE = process.env.BUG151_IMAGE || 'scratch-bug151:test';

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${observed ? `\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}` : ''}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}

function project(over = {}) {
  const { isolation = 'direct', browser, tools, hostPath = path.join(SCRATCH, 'proj') } = over;
  return {
    id: 'p-fixture', name: 'Fixture', hostPath, isolation,
    settings: { ...(browser ? { browser } : {}), ...(tools ? { tools } : {}) },
    createdAt: '', updatedAt: '',
  };
}

const tools = await import(path.join(ROOT, 'src/server/tools.ts'));
const bridge = await import(path.join(ROOT, 'src/server/agent-bridge.ts'));

/* ------------------------------------------------------------------ A: args */
console.log('\nA. The launch args a container session actually gets');
{
  // The env overrides must not leak in from whoever runs this script.
  delete process.env[tools.PLAYWRIGHT_CDP_ENV];
  delete process.env[tools.PLAYWRIGHT_EXECUTABLE_ENV];

  const c = tools.playwrightMcpServerFor(project({ isolation: 'container', tools: { playwright: true } }));
  check('container: headless', c.args.includes('--headless'), c.args.join(' '));
  check('container: names the baked browser, not the absent chrome channel',
    c.args.join(' ').includes('--browser chromium'), c.args.join(' '));
  check('container: no --executable-path guessed at a host path',
    !c.args.includes('--executable-path'), c.args.join(' '));
  check('container: execs the baked, pinned MCP binary',
    c.command === tools.CONTAINER_PLAYWRIGHT_BIN, c.command);

  const d = tools.playwrightMcpServerFor(project({ isolation: 'direct', tools: { playwright: true } }));
  check('direct: headless', d.args.includes('--headless'), d.args.join(' '));
  check('direct: pointed at a real host browser that exists',
    d.args.includes('--executable-path') && fs.existsSync(d.args[d.args.indexOf('--executable-path') + 1]),
    d.args.join(' '));
  check('direct: does NOT take the container branch',
    !d.args.includes('--browser'), d.args.join(' '));

  // Regression guard for the shape that caused this: an empty browser arg list
  // silently means "use the chrome channel".
  check('no isolation shape falls through to an empty browser arg list',
    tools.playwrightBrowserArgs(true).length > 0 && tools.playwrightBrowserArgs(false).length > 0,
    `container=${JSON.stringify(tools.playwrightBrowserArgs(true))} direct=${JSON.stringify(tools.playwrightBrowserArgs(false))}`);

  process.env[tools.PLAYWRIGHT_CDP_ENV] = 'http://127.0.0.1:9999';
  check('an explicit CDP endpoint still wins over the baked browser',
    tools.playwrightBrowserArgs(true).join(' ') === '--cdp-endpoint http://127.0.0.1:9999',
    tools.playwrightBrowserArgs(true).join(' '));
  delete process.env[tools.PLAYWRIGHT_CDP_ENV];
  process.env[tools.PLAYWRIGHT_EXECUTABLE_ENV] = '/some/browser';
  check('an explicit executable still wins over the baked browser',
    tools.playwrightBrowserArgs(true).join(' ') === '--executable-path /some/browser',
    tools.playwrightBrowserArgs(true).join(' '));
  delete process.env[tools.PLAYWRIGHT_EXECUTABLE_ENV];
}

/* ------------------------------------------------------ A2: image definition */
console.log('\nA2. The image definition promises a browser (and says why)');
{
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/server/container/provision.json'), 'utf8'));
  const b = manifest.tools?.playwright?.browser;
  check('provision.json pins the container browser', !!b && b.name === 'chromium', JSON.stringify(b?.name));
  check('pin records where it is installed', b?.installedTo === '/opt/ms-playwright', b?.installedTo);
  check('the pinned browser name is the one tools.ts passes',
    b?.name === tools.CONTAINER_PLAYWRIGHT_BROWSER, `${b?.name} vs ${tools.CONTAINER_PLAYWRIGHT_BROWSER}`);

  const df = fs.readFileSync(path.join(ROOT, 'src/server/container/Dockerfile'), 'utf8');
  check('Dockerfile installs the browser at BUILD time', /install --with-deps/.test(df));
  check('Dockerfile reads the browser name from the manifest, not a literal',
    /tools\.playwright\.browser\.name/.test(df));
  check('Dockerfile exports PLAYWRIGHT_BROWSERS_PATH so a non-root session can find it',
    /ENV PLAYWRIGHT_BROWSERS_PATH=\/opt\/ms-playwright/.test(df));
  check('the stale "browser is NOT baked here" decision is gone',
    !/browser is NOT baked here/.test(df));
}

/* -------------------------------------------------------------- B: real run */
console.log('\nB. The REAL image completes a REAL UI check, headless');

const haveDocker = spawnSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' }).status === 0;
if (!haveDocker) {
  console.log(`  SKIP  image ${IMAGE} not present — build it with:`);
  console.log('        docker build --build-arg HOST_UID=$(id -u) --build-arg HOST_GID=$(id -g) \\');
  console.log('          -t scratch-bug151:test src/server/container');
  check('container image available for the end-to-end check', false, `missing ${IMAGE}`);
} else {
  /*
   * A REALISTIC page, not a minimal one: the user's actual question was "does
   * clicking this link scroll the page to the form", which only has an answer
   * when the target is genuinely below the fold. A short page would pass with
   * scrollY 0 and prove nothing.
   */
  const web = path.join(SCRATCH, 'web');
  fs.mkdirSync(web, { recursive: true });
  fs.writeFileSync(path.join(web, 'page.html'), `<!doctype html><meta charset="utf-8"><title>Fixture</title>
<style>body{margin:0;font:16px system-ui} .pad{height:1400px;background:#eee} #request{height:400px;background:#cfc}</style>
<a href="#request" id="cta">request an app</a>
<div class="pad">filler</div>
<section id="request"><h2>Request form</h2></section>`);

  /*
   * Served over HTTP by a throwaway server inside the container, not opened as
   * file:// — @playwright/mcp blocks the file: protocol outright, and "a dev
   * server on localhost" is the shape the user's real check had anyway. The
   * network namespace is still `none`, so this can reach nothing but its own
   * loopback.
   */
  const realArgs = tools.playwrightMcpServerFor(project({ isolation: 'container', tools: { playwright: true } })).args;
  const mcp = spawn('docker', [
    'run', '--rm', '-i', '--network', 'none',
    '-v', `${web}:/w:ro`,
    '--entrypoint', '/bin/sh',
    IMAGE, '-c',
    `python3 -m http.server 8099 --bind 127.0.0.1 -d /w >/dev/null 2>&1 & exec ${tools.CONTAINER_PLAYWRIGHT_BIN} ${realArgs.join(' ')}`,
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  const replies = new Map();
  let buf = '';
  mcp.stdout.on('data', (d) => {
    buf += d;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines) { if (!l.trim()) continue; try { const j = JSON.parse(l); if (j.id != null) replies.set(j.id, j); } catch { /* not ours */ } }
  });
  let stderr = '';
  mcp.stderr.on('data', (d) => { stderr += d; });

  let nextId = 1;
  const rpc = (method, params, timeoutMs = 60_000) => new Promise((resolve, reject) => {
    const id = nextId++;
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const t0 = Date.now();
    const poll = setInterval(() => {
      if (replies.has(id)) { clearInterval(poll); resolve(replies.get(id)); }
      else if (Date.now() - t0 > timeoutMs) { clearInterval(poll); reject(new Error(`timeout on ${method}\n${stderr}`)); }
    }, 100);
  });
  const textOf = (r) => (r?.result?.content ?? []).map((c) => c.text ?? '').join('\n');

  try {
    const init = await rpc('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify-bug-151', version: '1' },
    });
    check('MCP server handshakes inside the image', !!init.result?.serverInfo, init.result?.serverInfo?.name);
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);

    const nav = await rpc('tools/call', { name: 'browser_navigate', arguments: { url: 'http://127.0.0.1:8099/page.html' } });
    const navText = textOf(nav);
    check('first navigate launches a browser instead of erroring', nav.result?.isError !== true, navText.slice(0, 220));
    check('the exact incident error is gone',
      !/is not found at \/opt\/google\/chrome\/chrome/.test(navText) && !/Executable doesn't exist/.test(navText),
      navText.slice(0, 220));
    check('it never tells the session to install a browser',
      !/playwright install/i.test(navText), navText.slice(0, 220));

    // The user's actual check, end to end: click the CTA, measure the scroll.
    const before = await rpc('tools/call', { name: 'browser_evaluate', arguments: { function: '() => ({ y: Math.round(scrollY), below: Math.round(document.getElementById("request").getBoundingClientRect().top) })' } });
    check('the fixture really is a below-the-fold target (not a trivial pass)',
      /"below": *\d{3,}/.test(textOf(before)) || /below: *\d{3,}/.test(textOf(before)), textOf(before).slice(-160));

    await rpc('tools/call', { name: 'browser_click', arguments: { element: 'request an app link', ref: 'e2' } })
      .catch(() => null); // ref-based click is snapshot-dependent; the evaluate below is the real measurement
    const after = await rpc('tools/call', { name: 'browser_evaluate', arguments: { function: '() => { document.getElementById("cta").click(); return new Promise(r => setTimeout(() => r({ y: Math.round(scrollY), hash: location.hash }), 300)); }' } });
    const afterText = textOf(after);
    const y = Number((afterText.match(/"y":\s*(\d+)/) || afterText.match(/y:\s*(\d+)/) || [])[1] ?? -1);
    check('clicking the CTA scrolls the page — the real UI question, answered headlessly',
      y > 500, `scrollY=${y} :: ${afterText.slice(-160)}`);

    const shot = await rpc('tools/call', { name: 'browser_take_screenshot', arguments: {} });
    check('a screenshot comes back (a real rendering pipeline, not a stub)',
      shot.result?.isError !== true && JSON.stringify(shot.result ?? {}).length > 500,
      `${JSON.stringify(shot.result ?? {}).length} bytes`);

    /*
     * The property the USER cares about: nothing appeared on their screen. The
     * browser is inside a container with no DISPLAY, so a window is impossible
     * by construction — assert that construction rather than trusting it.
     */
    const disp = await rpc('tools/call', { name: 'browser_evaluate', arguments: { function: '() => navigator.userAgent' } });
    check('ran as a real Chromium (user agent proves the engine)', /Chrome\//.test(textOf(disp)), textOf(disp).slice(-120));
    const env = spawnSync('docker', ['run', '--rm', '--entrypoint', '/bin/sh', IMAGE, '-c', 'echo "DISPLAY=[$DISPLAY]"; ls /tmp/.X11-unix 2>&1 | head -1'], { encoding: 'utf8' });
    check('the image has no DISPLAY and no X socket, so no window is possible',
      /DISPLAY=\[\]/.test(env.stdout) && !/^\s*X\d/m.test(env.stdout), env.stdout.trim());
  } finally {
    mcp.kill();
  }

  /*
   * DISCRIMINATING: run the OLD arg shape against the NEW image. If this passes,
   * the image change alone carried the fix and `--browser` is decoration; it must
   * still fail exactly the way the incident did.
   */
  console.log('\nB2. The old arg shape still fails on the new image (the flag is load-bearing)');
  const old = spawn('docker', ['run', '--rm', '-i', '--network', 'none', '--entrypoint', tools.CONTAINER_PLAYWRIGHT_BIN, IMAGE, '--headless'], { stdio: ['pipe', 'pipe', 'ignore'] });
  let ob = '', oseen = '';
  old.stdout.on('data', (d) => {
    ob += d; const ls = ob.split('\n'); ob = ls.pop();
    for (const l of ls) { if (l.includes('"id":2')) oseen = l; }
  });
  old.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'v', version: '1' } } })}\n`);
  await new Promise((r) => setTimeout(r, 2000));
  old.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
  old.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: 'about:blank' } } })}\n`);
  for (let i = 0; i < 100 && !oseen; i++) await new Promise((r) => setTimeout(r, 200));
  old.kill();
  check('without --browser, the default chrome channel still errors (so the flag is what fixed it)',
    /is not found at \\?\/opt\\?\/google/.test(oseen) || /chrome/i.test(oseen) && /Error/.test(oseen),
    oseen.slice(0, 220) || '(no reply)');
}

/* ---------------------------------------------------------- C: the guidance */
console.log('\nC. A session is told which browser is for what, at launch');
{
  const on = bridge.playwrightAvailabilityNote(true, { stealthEnabled: true, inContainer: true });
  check('states Playwright is headless', /headless/i.test(on));
  check('names it the default for ordinary UI work', /default browser for ordinary UI work/i.test(on));
  check('names the stealth browser and confines it to logged-in / bot-protection work',
    /stealth-browser/.test(on) && /logged-in profile/.test(on));
  check('breaks the tie explicitly', /When both would work, Playwright wins/.test(on));
  check('container: names the stale-image failure and forbids the two wrong reactions',
    /Executable doesn't exist/.test(on) && /do not run `playwright install`/i.test(on) && /do not fall back to the stealth browser/i.test(on));

  const onNoStealth = bridge.playwrightAvailabilityNote(true, { stealthEnabled: false, inContainer: false });
  check('no stealth browser: no advice about a tool the session does not have',
    !/stealth-browser/.test(onNoStealth));
  check('direct: no container-rebuild advice', !/rebuilding/.test(onNoStealth));

  const off = bridge.playwrightAvailabilityNote(false, { stealthEnabled: true, inContainer: true });
  check('ABSENCE is stated, not left to inference', /has NO Playwright/.test(off));
  check('absence explains the toolset is fixed at launch', /decided at launch/.test(off));
  check('absence forbids self-installing', /Never install Playwright or a browser yourself/.test(off));
  check('absence warns the remaining browser is headful and must be closed',
    /HEADFUL/.test(off) && /browser_close/.test(off));

  const offBoth = bridge.playwrightAvailabilityNote(false, { stealthEnabled: false, inContainer: false });
  check('no browsers at all: told to say so rather than improvise',
    /no browser at all/.test(offBoth) && !/browser_close/.test(offBoth));

  const broken = bridge.playwrightAvailabilityNote(true, { stealthEnabled: true, inContainer: true, unavailableReason: 'image is stale' });
  check('enabled-but-broken is its own state', /UNAVAILABLE: image is stale/.test(broken));
  check('broken state forbids substituting the headful browser',
    /do NOT substitute the headful stealth browser/.test(broken));

  // The other half of the choice has to be on the stealth side too, because a
  // session may read either note first.
  const stealth = bridge.browserAvailabilityNote(true);
  check('the stealth note also says it is not the default', /not the default browser/.test(stealth));
  check('the stealth note points at Playwright by tool name', /mcp__playwright__\*/.test(stealth));
  check('the stealth note keeps its FEAT-105 close instruction', /browser_close/.test(stealth));
  check('the stealth note keeps its FEAT-105 no-kill rule', /NEVER kill a browser process/.test(stealth));
}

/* ------------------------------------------------ D: note tracks the attach */
console.log('\nD. The note can never disagree with the attached tools');
{
  // plannedMcpServers resolves the stealth adapter's path when it is enabled;
  // point it at a scratch dir so this section exercises the ATTACH DECISION
  // without needing (or touching) the user's real adapter checkout.
  process.env.CLAUDE_STATION_SBMCP_REPO ||= path.join(SCRATCH, 'fake-adapter');
  for (const pw of [true, false]) {
    for (const sb of [true, false]) {
      for (const iso of ['direct', 'container']) {
        const p = project({ isolation: iso, browser: { enabled: sb }, tools: { playwright: pw, serena: true } });
        const plan = tools.plannedMcpServers(p);
        const attached = Object.keys(plan.servers).includes(tools.PLAYWRIGHT_SERVER_NAME);
        const note = bridge.playwrightAvailabilityNote(pw, { stealthEnabled: sb, inContainer: iso === 'container' });
        const claimsPresent = /You have Playwright/.test(note);
        check(`pw=${pw} stealth=${sb} ${iso}: attach and note agree`,
          attached === pw && claimsPresent === pw, `attached=${attached} note=${claimsPresent}`);
        const mentionsStealth = /stealth-browser/.test(note);
        check(`pw=${pw} stealth=${sb} ${iso}: stealth mentioned iff attached`,
          mentionsStealth === sb, `mentions=${mentionsStealth}`);
      }
    }
  }
}

/* --------------------------------------------------------------- E: the fleet */
console.log('\nE. Fleet (informational — reads the real registry, asserts nothing mutable)');
{
  const reg = path.join(process.env.CLAUDE_STATION_DATA || path.join(os.homedir(), '.local/share/claude-station'), 'registry.json');
  if (!fs.existsSync(reg)) console.log('  SKIP  no registry on this machine');
  else {
    const r = JSON.parse(fs.readFileSync(reg, 'utf8'));
    const rows = (r.projects ?? Object.values(r)).filter((p) => p?.settings);
    const risky = rows.filter((p) => p.settings.browser?.enabled && !p.settings.tools?.playwright);
    for (const p of rows) {
      const s = p.settings;
      if (s.browser?.enabled || s.tools?.playwright) {
        console.log(`        ${String(p.id).padEnd(20)} ${p.isolation.padEnd(10)} stealth=${!!s.browser?.enabled} playwright=${!!s.tools?.playwright}`);
      }
    }
    console.log(risky.length
      ? `  WARN  ${risky.length} project(s) have the HEADFUL browser but no Playwright, so a UI check there has only the wrong tool: ${risky.map((p) => p.id).join(', ')}`
      : '  OK    no project has the headful browser without Playwright');
  }
}

fs.rmSync(SCRATCH, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}  ${pass} passed, ${fail} failed`);
if (fail) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
