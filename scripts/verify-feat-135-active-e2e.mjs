#!/usr/bin/env node
/**
 * FEAT-135 — ACTIVE end-to-end proof that the git-write shim is WIRED into the
 * real runtime, not merely unit-correct.
 *
 *   node scripts/verify-feat-135-active-e2e.mjs
 *
 * scripts/verify-feat-135-git-shim.mjs proves the shim's DECISION logic and that
 * installGitShim() produces a PATH that refuses a subprocess git write. This
 * suite proves the missing half: that ClaudeRuntime.start() actually BUILDS the
 * session env through installGitShim, so the shim rides the env the SDK hands to
 * the `claude` CLI. It drives a REAL ClaudeRuntime host spawn (the same SDK
 * `spawnLocalProcess` path a live session uses; the SDK forwards options.env
 * verbatim as the child env — sdk.mjs `env:c` / `W.env=c`) with a fake `claude`
 * bin (CLAUDE_STATION_CLAUDE_BIN). That fake, running under the runtime-built
 * env, tries a NODE-SUBPROCESS git write against a THROWAWAY repo and records
 * the outcome. The wiring is proven ACTIVE iff that write is REFUSED.
 *
 * must-FAIL control: with ORCHARD_ALLOW_GIT_WRITE=1 (hatch open), the runtime
 * must NOT install the shim, so the SAME subprocess git write SUCCEEDS — proving
 * the refusal is the shim's doing and the hatch still works.
 *
 * Throwaway git repo + fake claude under os.tmpdir(); never touches this repo.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
let pass = 0, fail = 0;
const failures = [];
const cleanup = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}

/** A throwaway git repo with one commit, built with the REAL git (no shim). */
function throwawayRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat135-e2e-repo-'));
  cleanup.push(dir);
  const env = { ...process.env };
  delete env.GIT_INDEX_FILE;
  const g = (...args) => spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 'e2e@example.com');
  g('config', 'user.name', 'e2e');
  g('commit', '-q', '--allow-empty', '-m', 'base');
  const head = g('rev-parse', 'HEAD').stdout.trim();
  return { dir, head, headAt: () => g('rev-parse', 'HEAD').stdout.trim() };
}

/**
 * A fake `claude` that, when the SDK spawns it under the runtime-built env, runs
 * a node subprocess `git commit` (PATH-resolved → hits the shim if installed)
 * against $FEAT135_REPO and writes {code, stderr, shimDir} to $FEAT135_OUT.
 */
function writeFakeClaude(dir) {
  const p = path.join(dir, 'claude');
  fs.writeFileSync(p, [
    '#!/usr/bin/env node',
    'const { spawnSync } = require("node:child_process");',
    'const fs = require("node:fs");',
    'const repo = process.env.FEAT135_REPO;',
    // A grandchild node process resolves `git` via PATH exactly as a lane script would.
    'const r = spawnSync(process.execPath, ["-e", "const{execFileSync}=require(\'node:child_process\');try{execFileSync(\'git\',[\'commit\',\'--allow-empty\',\'-m\',\'evil\'],{cwd:process.env.FEAT135_REPO,stdio:[\'ignore\',\'ignore\',\'pipe\']});process.exit(0)}catch(e){process.stderr.write(String(e.stderr||e.message));process.exit(e.status||1)}"], { encoding: "utf8" });',
    'try { fs.writeFileSync(process.env.FEAT135_OUT, JSON.stringify({ code: r.status, stderr: String(r.stderr||"").slice(0,400), shimDir: process.env.ORCHARD_GIT_SHIM_DIR || null, pathHead: String(process.env.PATH||"").split(require("node:path").delimiter)[0] })); } catch {}',
    'process.exit(0);',
  ].join('\n'), { mode: 0o755 });
  return p;
}

/** Drive a REAL ClaudeRuntime host spawn; return the fake claude's recorded outcome. */
async function runThroughRuntime({ ClaudeRuntime, repo, hatchOpen }) {
  const cdir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat135-e2e-claude-'));
  cleanup.push(cdir);
  const outFile = path.join(cdir, 'out.json');
  const fakeClaude = writeFakeClaude(cdir);

  const saved = { bin: process.env.CLAUDE_STATION_CLAUDE_BIN, repo: process.env.FEAT135_REPO, out: process.env.FEAT135_OUT, hatch: process.env.ORCHARD_ALLOW_GIT_WRITE };
  process.env.CLAUDE_STATION_CLAUDE_BIN = fakeClaude;
  process.env.FEAT135_REPO = repo.dir;
  process.env.FEAT135_OUT = outFile;
  if (hatchOpen) process.env.ORCHARD_ALLOW_GIT_WRITE = '1'; else delete process.env.ORCHARD_ALLOW_GIT_WRITE;
  try {
    const rt = new ClaudeRuntime();
    try {
      rt.start({ cwd: cdir, firstPrompt: 'hi', permissionMode: 'default', onApproval: async () => ({ behavior: 'deny', message: 'n/a' }) });
      void (async () => { try { for await (const _ of rt.messages()) { /* drain */ } } catch { /* fake exits fast */ } })();
    } catch { /* SDK may throw on the immediate fake exit */ }
    const until = Date.now() + 8000;
    while (Date.now() < until && !fs.existsSync(outFile)) await sleep(30);
    try { rt.close(); } catch { /* ignore */ }
    if (!fs.existsSync(outFile)) return null;
    return JSON.parse(fs.readFileSync(outFile, 'utf8'));
  } finally {
    if (saved.bin === undefined) delete process.env.CLAUDE_STATION_CLAUDE_BIN; else process.env.CLAUDE_STATION_CLAUDE_BIN = saved.bin;
    if (saved.repo === undefined) delete process.env.FEAT135_REPO; else process.env.FEAT135_REPO = saved.repo;
    if (saved.out === undefined) delete process.env.FEAT135_OUT; else process.env.FEAT135_OUT = saved.out;
    if (saved.hatch === undefined) delete process.env.ORCHARD_ALLOW_GIT_WRITE; else process.env.ORCHARD_ALLOW_GIT_WRITE = saved.hatch;
  }
}

async function main() {
  const { ClaudeRuntime } = await import(`${path.join(ROOT, 'src', 'server', 'runtime', 'claude-runtime.ts')}`);

  console.log('\n===== FEAT-135 ACTIVE — block ON (default): the wired runtime refuses a subprocess git write =====');
  {
    const repo = throwawayRepo();
    const r = await runThroughRuntime({ ClaudeRuntime, repo, hatchOpen: false });
    if (!r) {
      check('the fake claude was spawned by the real runtime within the window', false, 'no out file — SDK never invoked the fake');
    } else {
      check('the fake claude was spawned by the real runtime and ran a subprocess git write', true, r);
      check('runtime installed the shim onto the session env (ORCHARD_GIT_SHIM_DIR present, PATH head is the shim dir)',
        !!r.shimDir && r.pathHead === r.shimDir, { shimDir: r.shimDir, pathHead: r.pathHead });
      check('subprocess git commit REFUSED (nonzero exit) via the real runtime path', r.code !== 0, { code: r.code });
      check('the refusal is the loud FEAT-135 shim refusal', /git write refused at the invocation layer/.test(r.stderr || ''), (r.stderr || '').slice(0, 160));
      check('HEAD of the throwaway repo unchanged by the refused write', repo.headAt() === repo.head, { before: repo.head.slice(0, 12), after: repo.headAt().slice(0, 12) });
    }
  }

  console.log('\n===== FEAT-135 must-FAIL control — hatch OPEN: the runtime does NOT install the shim, write SUCCEEDS =====');
  {
    const repo = throwawayRepo();
    const r = await runThroughRuntime({ ClaudeRuntime, repo, hatchOpen: true });
    if (!r) {
      check('[control] the fake claude was spawned within the window', false, 'no out file');
    } else {
      check('[control] no shim installed when the hatch is open', !r.shimDir, { shimDir: r.shimDir });
      check('[control] subprocess git commit SUCCEEDS with the hatch open (proves the refusal above was the shim)', r.code === 0, { code: r.code, stderr: (r.stderr || '').slice(0, 120) });
      check('[control] HEAD of the throwaway repo MOVED (the write landed)', repo.headAt() !== repo.head, { before: repo.head.slice(0, 12), after: repo.headAt().slice(0, 12) });
    }
  }
}

main()
  .catch((e) => { console.error(e); fail++; failures.push(`threw: ${e?.message ?? e}`); })
  .finally(() => {
    for (const d of cleanup) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
    console.log(`\n== ${pass} passed, ${fail} failed ==`);
    if (failures.length) console.log('  failed:', failures.join(' | '));
    process.exit(fail === 0 ? 0 : 1);
  });
