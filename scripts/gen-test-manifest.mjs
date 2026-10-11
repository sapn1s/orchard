#!/usr/bin/env node
/**
 * gen-test-manifest.mjs — regenerate scripts/test-manifest.json (FEAT-033).
 *
 * ONE owner for the fact "which tier does each verify suite need" (ARCH-010).
 * This generator derives a tier for every `verify*` npm script by INSPECTING the
 * target file for the signals below, merges a small hand-maintained OVERRIDES map
 * (for the handful inspection cannot get right), and writes the result to
 * scripts/test-manifest.json. The RUNNER (test-runner.mjs / `npm test`) only READS
 * that JSON — it never re-derives a tier. Re-run this generator when a suite is
 * added, removed, or reclassified, then commit the JSON.
 *
 * Tiers (most-restrictive wins):
 *   host-live      needs the user's live service, real `claude` CLI, network, a
 *                  provider key, systemctl, or a connection to :4317. NEVER run by default.
 *   docker-sandbox creates/sweeps Docker objects; must run in the standing sandbox,
 *                  serialized (the sandbox holds an exclusive lock). Opt-in.
 *   browser        a Playwright `.spec.ts`; needs a browser (reuses system Brave). Opt-in.
 *   scratch-server boots an isolated scratch server (free port + scratch dataDir). Local-safe.
 *   pure           no server, no browser, no docker, no network. CI-portable.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(HERE, 'test-manifest.json');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/** Hand overrides where static inspection is wrong. tier or 'broken'. */
const OVERRIDES = {
  // aggregate runner of all browser specs — would double-run; not a single suite.
  'qa:sweep': { skip: true, why: 'aggregate playwright runner, not one suite' },
  // the clean-room independent-verify harness: expensive, exports the tree + boots. host-only.
  'verify:clean-room': { tier: 'host-live', why: 'independent-verify clean room; expensive, host' },
  // These read a REAL artifact that only exists in the user's live store / on the live
  // server — a static signal cannot see it, so they were mis-tiered as runnable locally and
  // FAIL their own precondition anywhere else (FEAT-033 health run, 2026-10-10). They are
  // genuinely host-live, not default-runnable:
  //   verify:live        — needs a specific multi-hundred-MB session jsonl in ~/.claude.
  //   verify:feat-154-open — needs the exact real session it was built from.
  //   verify:mcp-ready   — drives ClaudeRuntime in-process; the store-isolation guard
  //                        refuses any non-production station server, so it only runs live.
  'verify:live': { tier: 'host-live', why: 'needs a real multi-hundred-MB session in ~/.claude' },
  'verify:feat-154-open': { tier: 'host-live', why: 'needs the real session it was built from' },
  'verify:mcp-ready': { tier: 'host-live', why: 'in-process runtime; store-isolation guard refuses any non-production server' },
};

/**
 * Per-suite timeout (seconds) where a suite is legitimately longer than the global
 * default and was TIMING OUT only for that reason (FEAT-033 health run, 2026-10-10).
 * The runner treats the global --timeout as a floor; this only RAISES the budget.
 * Reserved for suites with EVIDENCE they complete when given the time (continuous
 * progress output right up to the kill), never to paper over a hang.
 */
const TIMEOUTS = {
  // boot-probe sweep: spawns ~30+ fresh child processes, each a 5 s --version probe, serially.
  'verify:bug-247': 600,
  // deadline-guard suite: a large ledger + many independent-verify break cases, serial.
  'verify:bug-239-bound-hangs': 600,
  // grades the whole real ticket corpus for the duplicate-state guard.
  'verify:bug-123': 600,
};

/** Extract the script file referenced by an npm command, and whether it is a playwright spec. */
function parse(cmd) {
  const playwright = /\bplaywright test\b/.test(cmd);
  // find a scripts/… path token
  const m = cmd.match(/\b(scripts\/[\w./-]+\.(?:mjs|mts|ts|js))\b/);
  return { playwright, file: m ? m[1] : null };
}

const SIG = {
  hostLive: [
    /spawn(?:Sync)?\(\s*['"]claude['"]/,
    /execFileSync\(\s*['"]claude['"]/,
    /ANTHROPIC_API_KEY|OPENAI_API_KEY/,
    /api\.(?:anthropic|openai)\.com/,
    /\bsystemctl\b/,
    /(?:localhost|127\.0\.0\.1):4317|ws:\/\/[^'"`]*:4317/,
  ],
  docker: [/docker-sandbox\.mjs|assertIsolatedDocker|owned-docker\.mjs|useHostDocker\b/],
  // A real browser launch: a debugging-port / DevTools handshake, system-Brave reuse
  // via executablePath, or the bundled chromium under ms-playwright.
  browser: [/--remote-debugging-port|remoteDebuggingPort|DevToolsActivePort|ms-playwright|executablePath/],
  // Boots an isolated scratch server: spawns the server entrypoint or uses station-boot.
  scratchServer: [
    /station-boot/,
    /isolatedServerEnv|bootStationServer|startScratchServer/,
    /src\/server\/index\.(?:ts|mjs)/,
  ],
  // Spawns a git WRITE (init/add/commit/checkout …). Legal in a scratch/fixture repo,
  // but a git-write-restricted dispatched lane (FEAT-135 backstop) blocks it, so these
  // cannot pass there — surfaced as needsGit so the runner can note it rather than
  // mis-report a lane artifact as a product regression.
  gitWrite: [/spawn(?:Sync)?\(\s*['"]git['"]/, /execFileSync\(\s*['"]git['"]/, /\bgit (?:init|add|commit|checkout|reset|branch|tag)\b/],
};
const any = (re, s) => re.some((r) => r.test(s));

function classify(name, cmd) {
  const ov = OVERRIDES[name];
  if (ov?.skip) return null;
  const { playwright, file } = parse(cmd);
  const abs = file ? path.join(ROOT, file) : null;
  const src = abs && fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
  const needsGit = src ? any(SIG.gitWrite, src) : false;
  const tag = (tier, why) => ({ tier, file, why, ...(needsGit ? { needsGit: true } : {}) });
  if (ov?.tier) return tag(ov.tier, ov.why);
  if (playwright) return tag('browser', 'playwright spec');
  if (!file) return { tier: 'pure', file: null, why: 'no script file in command' };
  if (!fs.existsSync(abs)) return { tier: 'broken', file, why: 'target file missing' };
  if (any(SIG.hostLive, src)) return tag('host-live', 'live service / CLI / network / systemctl / :4317');
  if (any(SIG.docker, src)) return tag('docker-sandbox', 'creates/sweeps Docker objects');
  if (any(SIG.browser, src)) return tag('browser', 'launches a real browser (CDP/Brave/chromium)');
  if (any(SIG.scratchServer, src)) return tag('scratch-server', 'boots an isolated scratch server');
  return tag('pure', 'no server/browser/docker/network signal');
}

const suites = {};
for (const [name, cmd] of Object.entries(pkg.scripts)) {
  if (!/^verify([:-]|$)/.test(name)) continue;
  const c = classify(name, cmd);
  if (!c) continue;
  if (TIMEOUTS[name]) c.timeoutSec = TIMEOUTS[name];
  suites[name] = c;
}

const manifest = {
  _comment: 'GENERATED by scripts/gen-test-manifest.mjs — do not hand-edit tiers; edit OVERRIDES there and regenerate. The runner (npm test) reads this; it never re-derives.',
  generatedAt: new Date().toISOString().slice(0, 10),
  tiers: {
    pure: 'no server/browser/docker/network — CI portable',
    'scratch-server': 'boots an isolated scratch server (free port + scratch dataDir)',
    browser: 'Playwright spec; needs a browser (system Brave)',
    'docker-sandbox': 'creates/sweeps Docker objects; serialized in the standing sandbox',
    'host-live': 'needs live service / real CLI / network / provider key — never run by default',
    broken: 'target file missing',
  },
  suites,
};

const counts = {};
for (const s of Object.values(suites)) counts[s.tier] = (counts[s.tier] || 0) + 1;

if (process.argv.includes('--check')) {
  const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  const next = JSON.stringify(manifest, null, 2) + '\n';
  // compare ignoring generatedAt
  const strip = (s) => s.replace(/"generatedAt":\s*"[^"]*"/, '');
  if (strip(existing) !== strip(next)) {
    console.error('test-manifest.json is STALE — run `node scripts/gen-test-manifest.mjs`');
    process.exit(1);
  }
  console.log('test-manifest.json is up to date');
  process.exit(0);
}

fs.writeFileSync(OUT, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Wrote ${OUT}: ${Object.keys(suites).length} suites`);
for (const [t, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${t.padEnd(16)} ${n}`);
