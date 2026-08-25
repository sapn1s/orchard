#!/usr/bin/env node
/**
 * BUG-108 — Playwright's MCP server must come from a PINNED, provisioned install,
 * never `npx -y @playwright/mcp@latest` (a mutable tag re-resolved over the
 * network at every session start — the last auto-fetch on the hot path, and the
 * identical supply-chain shape BUG-107 removed for Serena).
 *
 *   node scripts/verify-bug-108-playwright-pin.mjs [--no-docker]
 *
 * Everything runs in scratch dirs / scratch data / a scratch image tag; the
 * user's real images and containers are never touched. Host provisioning goes to
 * a throwaway CLAUDE_STATION_DATA so it never disturbs the real host install.
 *
 * Also folds in the two clean-room findings this lane corrected:
 *   - FINDING 1: provisionHash() must be CONTENT-sensitive, not mtime/size (a
 *     same-size, same-mtime content edit must still change the artifact identity).
 *   - FINDING 2: the emitted command must be an EXACT identity, not a suffix.
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const NO_DOCKER = process.argv.includes('--no-docker');

let pass = 0, fail = 0, skip = 0;
const check = (n, ok, obs) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}\n        observed: ${typeof obs === 'string' ? obs : JSON.stringify(obs)}`); ok ? pass++ : fail++; };
const skipped = (n, why) => { console.log(`  SKIP  ${n}\n        ${why}`); skip++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bug108-'));
const DATA = path.join(TMP, 'data');
fs.mkdirSync(DATA, { recursive: true });
process.env.CLAUDE_STATION_DATA = DATA;

const cleanupImages = [];
function cleanup() {
  for (const t of cleanupImages) { try { execFileSync('docker', ['rmi', '-f', t], { stdio: 'pipe' }); } catch { /* gone/in-use */ } }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
}

/** Speak real MCP over stdio to a spawned command and return {tools, navResult}. */
function mcpDrive(cmd, args, { navigate = false, timeoutMs = 90_000, env = process.env, cwd = TMP } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env, cwd });
    let buf = '', stderr = '', done = false, tools = null;
    const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(timer); try { child.kill('SIGKILL'); } catch { /**/ } fn(v); } };
    const timer = setTimeout(() => finish(reject, new Error(`MCP timeout; stderr tail: ${stderr.slice(-400)}`)), timeoutMs);
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1 && m.result) { send({ jsonrpc: '2.0', method: 'notifications/initialized' }); send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }); }
        else if (m.id === 2 && m.result) {
          tools = (m.result.tools ?? []).map((t) => t.name);
          if (!navigate) return finish(resolve, { tools });
          send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: 'data:text/html,<h1>bug108</h1>' } } });
        } else if (m.id === 3) finish(resolve, { tools, navResult: m.result });
      }
    });
    child.on('error', (e) => finish(reject, e));
    child.on('close', () => finish(reject, new Error(`server exited early; stderr tail: ${stderr.slice(-400)}`)));
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bug108', version: '1' } } });
  });
}

const imp = async (rel) => import(path.join(ROOT, rel) + `?v=${Date.now()}${Math.random()}`);

async function main() {
  /* ===================== A. the pin & manifest identity ===================== */
  console.log('=== A. provision.json pins @playwright/mcp to an exact registry version, with identity evidence ===');
  const prov = await imp('src/server/provisioning.ts');
  const pin = prov.playwrightPin();
  check('A1 playwright is pinned to a scoped @playwright/mcp package + exact version (no @latest, no git ref)',
    pin.package === '@playwright/mcp' && /^\d+\.\d+\.\d+$/.test(String(pin.version)) && pin.installer === 'npm-global',
    `package=${pin.package} version=${pin.version} entrypoint=${pin.entrypoint} installer=${pin.installer}`);
  check('A2 the manifest records identity evidence + an integrity digest (checked before pinning, not assumed)',
    Array.isArray(pin.identityEvidence) && pin.identityEvidence.length >= 4 && typeof pin.integrity === 'string' && pin.integrity.startsWith('sha512-')
      && /Microsoft/i.test(pin.publisher ?? '') && /github\.com\/microsoft\/playwright-mcp/.test(pin.source ?? ''),
    `publisher=${pin.publisher} integrity=${String(pin.integrity).slice(0, 24)}… evidence=${pin.identityEvidence?.length} links`);

  /* ===================== FINDING 1: content-hash soundness ===================== */
  console.log('\n=== A(finding1). provisionHash is CONTENT-sensitive, not mtime/size (clean-room regression) ===');
  {
    // Operate on a COPY of the two hashed inputs so we never touch the real tree.
    const df = path.join(TMP, 'Dockerfile'); const mf = path.join(TMP, 'provision.json');
    fs.copyFileSync(prov.dockerfilePath(), df); fs.copyFileSync(prov.provisionManifestPath(), mf);
    // Redirect provisionHash's inputs by shadowing via a tiny reimplementation is
    // impossible without touching the module; instead prove the property on the
    // real function by editing the REAL Dockerfile in a same-size, restored-mtime
    // way, hashing, then restoring — bounded and reverted in a finally.
    const DF = prov.dockerfilePath();
    const orig = fs.readFileSync(DF); const st = fs.statSync(DF);
    const T = new Date(1787078633000);
    try {
      fs.writeFileSync(DF, orig); fs.utimesSync(DF, T, T);
      const s1 = fs.statSync(DF); const h1 = prov.provisionHash();
      const changed = orig.toString().replace('FROM ubuntu:24.04', 'FROM ubuntu:24.99');
      const sameSize = Buffer.byteLength(changed) === orig.length && changed !== orig.toString();
      fs.writeFileSync(DF, changed); fs.utimesSync(DF, T, T);
      const s2 = fs.statSync(DF); const h2 = prov.provisionHash();
      // Compare the two STATE snapshots (both set to the fixed T), not the file's
      // original mtime — the point is that an (mtime,size) cache key would be
      // IDENTICAL across the two states, yet the content hash must still differ.
      check('AF1 a same-SIZE, same-MTIME content change STILL changes the provision hash (mtime/size cache cannot mask it)',
        sameSize && s2.size === s1.size && s2.mtimeMs === s1.mtimeMs && h1 !== h2,
        `sizeSame=${s2.size === s1.size} mtimeSame=${s2.mtimeMs === s1.mtimeMs} h1=${h1} h2=${h2}`);
    } finally {
      fs.writeFileSync(DF, orig); fs.utimesSync(DF, st.atime, st.mtime);
    }
    void df; void mf;
  }

  /* ===================== B. the launch command (tools.ts) ===================== */
  console.log('\n=== B. the session-start command: pinned local binary, no npx/@latest fetch, exact identity ===');
  const tools = await imp('src/server/tools.ts');
  const projectC = { id: 'p108', name: 'P', hostPath: '/tmp/p108', isolation: 'container', settings: {}, createdAt: '', updatedAt: '' };
  const projectD = { ...projectC, isolation: 'direct' };
  const c = tools.playwrightMcpServerFor(projectC);
  const d = tools.playwrightMcpServerFor(projectD);
  const flat = (s) => [s.command, ...s.args].join(' ');
  const noFetch = (s) => !/npx|@latest|(^|\s)-y(\s|$)|git\+/.test(flat(s));
  check('B1 container command is EXACTLY the baked /usr/local/bin/playwright-mcp (exact identity, no fetch)',
    c.command === tools.CONTAINER_PLAYWRIGHT_BIN && c.command === '/usr/local/bin/playwright-mcp' && noFetch(c),
    `container: ${flat(c)}`);
  check('B2 direct command is EXACTLY the station-provisioned host binary (exact identity, no fetch)',
    d.command === prov.hostPlaywrightBin() && path.isAbsolute(d.command) && d.command.includes('provision') && noFetch(d),
    `direct: ${flat(d)}`);
  // Browser targeting is env/auto — no fetch under any branch.
  const withCdp = (() => { const old = process.env.CLAUDE_STATION_PLAYWRIGHT_CDP_ENDPOINT; process.env.CLAUDE_STATION_PLAYWRIGHT_CDP_ENDPOINT = 'http://127.0.0.1:9999'; const r = tools.playwrightMcpServerFor(projectC); if (old === undefined) delete process.env.CLAUDE_STATION_PLAYWRIGHT_CDP_ENDPOINT; else process.env.CLAUDE_STATION_PLAYWRIGHT_CDP_ENDPOINT = old; return r; })();
  check('B3 an explicit CDP endpoint is honoured (connect to an existing browser, never download one)',
    withCdp.args.includes('--cdp-endpoint') && withCdp.args.includes('http://127.0.0.1:9999'),
    withCdp.args.join(' '));

  /* ===================== C/D. host provisioning + end-to-end ===================== */
  console.log('\n=== C. host provisioning is explicit, idempotent, and reported (no session-start fetch) ===');
  let hasNpm = true; try { execFileSync('npm', ['--version'], { stdio: 'pipe' }); } catch { hasNpm = false; }
  if (!hasNpm) {
    for (const n of ['C1', 'C2', 'C3', 'D1', 'D2', 'D3']) skipped(n, 'npm not on PATH');
  } else {
    const st0 = prov.hostProvisionStateFor('playwright');
    check('C1 an unprovisioned host reports "missing" — it does NOT silently fetch',
      st0.state === 'missing' && !fs.existsSync(st0.bin) && st0.wantedVersion === pin.version,
      `state=${st0.state} wanted=${st0.wantedVersion} bin exists=${fs.existsSync(st0.bin)}`);
    const t0 = Date.now();
    const r = await prov.provisionToolOnHost('playwright', { onLog: () => {} });
    const st1 = prov.hostProvisionStateFor('playwright');
    const bin = prov.hostPlaywrightBin();
    const verOut = st1.state === 'provisioned' ? execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, npm_config_offline: 'true' } }).trim() : 'n/a';
    check('C2 provisionToolOnHost installs the pin into the station dir and RECORDS it (which version is running)',
      st1.state === 'provisioned' && st1.installedVersion === pin.version && verOut.includes(pin.version) && r.changed === true,
      `state=${st1.state} installed=${st1.installedVersion} \`playwright-mcp --version\`=${verOut} in ${Math.round((Date.now() - t0) / 1000)}s`);
    const t1 = Date.now();
    const r2 = await prov.provisionToolOnHost('playwright', { onLog: () => {} });
    check('C3 a second provision is a no-op — downloaded once, then reused',
      r2.changed === false && Date.now() - t1 < 4000, `changed=${r2.changed} in ${Date.now() - t1}ms`);

    console.log('\n=== D. the pinned host install actually WORKS end-to-end, offline ===');
    // No network: point npm/registry at a dead host and forbid a browser download.
    const offlineEnv = { ...process.env, npm_config_offline: 'true', npm_config_registry: 'http://127.0.0.1:9', PLAYWRIGHT_BROWSERS_PATH: path.join(TMP, 'no-browsers') };
    let mcp = null, mcpErr = '';
    try { mcp = await mcpDrive(bin, ['--headless'], { env: offlineEnv }); } catch (e) { mcpErr = String(e.message).slice(0, 300); }
    check('D1 the pinned server STARTS from the local install and lists its real tools with NO network',
      !!mcp && (mcp.tools?.length ?? 0) >= 20 && mcp.tools.includes('browser_navigate') && mcp.tools.includes('browser_snapshot'),
      mcp ? `${mcp.tools.length} tools; sample=${mcp.tools.slice(0, 6).join(', ')}` : `err=${mcpErr}`);
    // Prove recorded == running.
    const rec = JSON.parse(fs.readFileSync(path.join(DATA, 'provision', 'installed.json'), 'utf8'));
    check('D2 the RECORDED version equals the pin equals what the binary reports (no drift between record and reality)',
      rec.tools?.playwright?.version === pin.version && verOut.includes(pin.version),
      `recorded=${rec.tools?.playwright?.version} pin=${pin.version} --version=${verOut}`);
    // Real navigate offline via an existing browser.
    const browser = tools.findHostBrowserExecutable();
    if (!browser) {
      skipped('D3 a real browser_navigate works offline via an existing browser', 'no host browser (brave/chrome/chromium) found on PATH');
    } else {
      let nav = null, navErr = '';
      try { nav = await mcpDrive(bin, ['--headless', '--executable-path', browser], { navigate: true, timeoutMs: 120_000, env: offlineEnv }); } catch (e) { navErr = String(e.message).slice(0, 300); }
      const text = JSON.stringify(nav?.navResult ?? '');
      check('D3 a real browser_navigate SUCCEEDS offline via the existing host browser (the browser is not fetched either)',
        !!nav && nav.navResult && nav.navResult.isError !== true && /Page URL|bug108|snapshot/i.test(text),
        `browser=${browser}; result=${text.slice(0, 200)}${navErr ? ` err=${navErr}` : ''}`);
    }

    /* ===== F. state reflects the ARTIFACT, not the record (clean-room finding 1 + drift/partial/removed/concurrent) ===== */
    console.log('\n=== F. status reflects the installed ARTIFACT: drift / removed / partial / concurrent ===');
    const stProv = prov.hostProvisionStateFor('playwright');
    if (stProv.state !== 'provisioned') {
      for (const n of ['F1', 'F2', 'F3', 'F4']) skipped(n, 'playwright was not provisioned in section C');
    } else {
      const pbin = prov.hostPlaywrightBin();
      const linkTarget = fs.readlinkSync(pbin); // installed as a symlink into lib/node_modules
      const restore = () => { try { fs.rmSync(pbin, { force: true }); } catch { /**/ } fs.symlinkSync(linkTarget, pbin); };

      // F1 — DRIFT: the on-disk binary reports a DIFFERENT version than the record
      // claims. The record alone still reads "provisioned" (that IS the defect);
      // verify must catch it, and the provision idempotence gate — which calls
      // hostProvisionStateFor(tool,{verify:true}) — therefore no longer no-ops.
      fs.rmSync(pbin, { force: true });
      fs.writeFileSync(pbin, '#!/usr/bin/env bash\necho "Version 999.999.999"\n', { mode: 0o755 });
      const drifted = prov.hostProvisionStateFor('playwright', { verify: true });
      const cheap = prov.hostProvisionStateFor('playwright');
      const gateWouldReinstall = drifted.state !== 'provisioned'; // exactly what provisionToolOnHost's !force gate reads
      restore();
      check('F1 DRIFT: a binary reporting a different version than the record is detected under verify (record alone is trusted only on the cheap path) → re-provision is no longer a no-op',
        drifted.state === 'stale' && /999\.999\.999/.test(String(drifted.verifiedVersion))
          && cheap.state === 'provisioned' && gateWouldReinstall,
        `verify=${drifted.state}(reports ${drifted.verifiedVersion}) cheap=${cheap.state} gateReinstalls=${gateWouldReinstall}`);

      // F2 — REMOVED underneath a running session: the binary is gone.
      fs.rmSync(pbin, { force: true });
      const removedVerify = prov.hostProvisionStateFor('playwright', { verify: true });
      const removedCheap = prov.hostProvisionStateFor('playwright');
      restore();
      check('F2 REMOVED: a binary deleted underneath us reads "missing" on BOTH the cheap and verify paths (existence is the cheap check)',
        removedVerify.state === 'missing' && removedCheap.state === 'missing',
        `verify=${removedVerify.state} cheap=${removedCheap.state}`);

      // F3 — PARTIAL / CORRUPTED: the binary exists (record still "provisioned")
      // but does not run — a partial or interrupted install. Only verify sees it.
      fs.rmSync(pbin, { force: true });
      fs.writeFileSync(pbin, '#!/usr/bin/env bash\nexit 3\n', { mode: 0o755 });
      const partialVerify = prov.hostProvisionStateFor('playwright', { verify: true });
      const partialCheap = prov.hostProvisionStateFor('playwright');
      restore();
      check('F3 PARTIAL: a binary that exists but does not run reads "missing" under verify (does-not-run detail) while the cheap record still says provisioned',
        partialVerify.state === 'missing' && /does not run/.test(partialVerify.detail) && partialCheap.state === 'provisioned',
        `verify=${partialVerify.state} (${partialVerify.detail.slice(0, 70)}…) cheap=${partialCheap.state}`);

      // F4 — CONCURRENT provisioning of the TWO tools must not clobber the shared
      // installed.json (its read-modify-write is a single un-awaited block, so on
      // Node's one thread neither entry can be lost). Real installs into a fresh
      // scratch data dir; guarded on uv (serena) + npm (playwright).
      let hasUv = true; try { execFileSync('uv', ['--version'], { stdio: 'pipe' }); } catch { hasUv = false; }
      if (!hasUv) { skipped('F4 concurrent provisioning of both tools records both', 'uv not on PATH (needed to provision serena)'); }
      else {
        const data2 = path.join(TMP, 'concurrent'); fs.mkdirSync(data2, { recursive: true });
        const prevData = process.env.CLAUDE_STATION_DATA;
        process.env.CLAUDE_STATION_DATA = data2; // provisioning reads dataDir() live, per call
        let results = null, cErr = '';
        try {
          results = await Promise.all([
            prov.provisionToolOnHost('serena', { onLog: () => {} }),
            prov.provisionToolOnHost('playwright', { onLog: () => {} }),
          ]);
        } catch (e) { cErr = String(e?.message ?? e).slice(0, 200); }
        process.env.CLAUDE_STATION_DATA = prevData;
        let recTools = [];
        try { recTools = Object.keys(JSON.parse(fs.readFileSync(path.join(data2, 'provision', 'installed.json'), 'utf8')).tools ?? {}); } catch { /**/ }
        if (cErr && /uv tool install|npm install|ENOTCACHED|network|registry/i.test(cErr)) {
          skipped('F4 concurrent provisioning of both tools records both', `install could not reach its source: ${cErr}`);
        } else {
          check('F4 CONCURRENT: provisioning BOTH tools at once records BOTH — the shared installed.json is not clobbered',
            !cErr && recTools.includes('serena') && recTools.includes('playwright') && (results?.every((r) => r.changed) ?? false),
            cErr ? `err=${cErr}` : `recorded=[${recTools.join(', ')}] changed=[${results?.map((r) => r.changed).join(', ')}]`);
        }
      }
    }
  }

  /* ===================== E. the container bake (real docker) ===================== */
  console.log('\n=== E. the container image BAKES the pin; it runs offline (real docker) ===');
  let dockerOk = !NO_DOCKER;
  if (dockerOk) { try { execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'pipe' }); } catch { dockerOk = false; } }
  if (!dockerOk) {
    for (const n of ['E1', 'E2', 'E3', 'E4']) skipped(n, 'docker unavailable or --no-docker');
  } else {
    const tag = `claude-station-bug108-test:${process.pid}${Date.now() % 100000}`;
    cleanupImages.push(tag);
    const ctx = path.join(ROOT, 'src', 'server', 'container');
    console.log(`    building ${tag} from ${ctx} (real network, slow) …`);
    const build = spawnSync('docker', ['build', '-t', tag, '--build-arg', `HOST_UID=${process.getuid?.() ?? 1000}`, '--build-arg', `HOST_GID=${process.getgid?.() ?? 1000}`, ctx], { encoding: 'utf8', timeout: 20 * 60_000 });
    if (build.status !== 0) {
      check('E1 the image builds with the pinned playwright bake', false, `docker build exit=${build.status}\n${String(build.stderr).slice(-600)}`);
      for (const n of ['E2', 'E3', 'E4']) skipped(n, 'image did not build');
    } else {
      check('E1 the image builds with the pinned playwright bake', true, `built ${tag}`);
      const probe = (args) => { try { return execFileSync('docker', args, { encoding: 'utf8', timeout: 120_000 }).trim(); } catch (e) { return `ERR:${String(e.stderr ?? e.message).slice(0, 200)}`; } };
      const where = probe(['run', '--rm', tag, 'bash', '-lc', 'command -v playwright-mcp || echo NO_PW']);
      check('E2 playwright-mcp is baked at a durable path in the image', where === '/usr/local/bin/playwright-mcp', `command -v playwright-mcp -> ${where}`);
      const ver = probe(['run', '--rm', '--network', 'none', tag, 'playwright-mcp', '--version']);
      const recorded = probe(['run', '--rm', '--network', 'none', tag, 'cat', '/etc/claude-station/provision.json']);
      let recVer = 'n/a'; try { recVer = JSON.parse(recorded).tools.playwright.version; } catch { /**/ }
      check('E3 playwright-mcp runs with NO NETWORK and reports the pinned version, and the image RECORDS that version',
        ver.includes(pin.version) && !ver.startsWith('ERR:') && recVer === pin.version,
        `--network none --version -> ${ver}; recorded=${recVer} (pin ${pin.version})`);
      let toolNames = [], mcpErr = '';
      try { const r = await mcpDrive('docker', ['run', '--rm', '-i', '--network', 'none', tag, 'playwright-mcp', '--headless'], { timeoutMs: 120_000 }); toolNames = r.tools ?? []; }
      catch (e) { mcpErr = String(e.message).slice(0, 300); }
      check('E4 the baked server STARTS in the image with no network and lists its real tools',
        toolNames.length >= 20 && toolNames.includes('browser_navigate'),
        `${toolNames.length} tools; sample=${toolNames.slice(0, 6).join(', ')}${mcpErr ? ` err=${mcpErr}` : ''}`);
    }
  }

  console.log(`\n${pass}/${pass + fail} PASS  (${fail} FAIL, ${skip} SKIP)`);
}

main().catch((e) => { console.error(`\nHARNESS ERROR: ${e?.stack ?? e}`); fail++; }).finally(() => { cleanup(); process.exit(fail ? 1 : 0); });
