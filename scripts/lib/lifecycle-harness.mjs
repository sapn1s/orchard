/**
 * ARCH-022 — for suites that drive the container managers in-process.
 *
 * Since ARCH-022 a docker mutation runs only inside a lifecycle OPERATION of a booted authority that
 * holds its data dir. A suite that calls `cm.ensureContainer`, `svc.ensureServices`, `cm.pruneSuperseded…`
 * and friends directly therefore boots the authority first (a REAL claim on its scratch data dir, and
 * boot recovery — exactly what a server does) and wraps each direct manager call in `op(projectId, fn)`.
 *
 * Against a pre-ARCH-022 tree (a pinned must-FAIL snapshot, which has no lifecycle.ts) both are no-ops,
 * so the same suite still runs there unchanged.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Boot the authority of the tree at `treeRoot` (no-op on a tree without one). Returns { lc, op, dispose }. */
export async function bootAuthority(treeRoot) {
  const file = path.join(treeRoot, 'src', 'server', 'lifecycle.ts');
  if (!fs.existsSync(file)) {
    return { lc: null, op: (_pid, fn) => Promise.resolve().then(fn), drainImages: () => Promise.resolve(), dispose: () => undefined };
  }
  const lc = await import(file);
  const lanes = await import(path.join(treeRoot, 'src', 'server', 'lanes.ts'));
  const b = await lc.bootForTests();
  return {
    lc,
    /** Run `fn` inside a 'maintain' operation of `projectId` (the authority then checks each mutation). */
    op: (projectId, fn) => lc.runOp(projectId, 'maintain', async () => fn()),
    /** Wait until the image-cleanup slot has run everything scheduled so far (the prune runs after an ensure). */
    drainImages: () => lc.runOp('#images', 'prune', async () => undefined),
    /** Stop the authority's timers and let the data dir go (so a scratch server can claim it). */
    dispose: () => { b.dispose(); lanes.releaseWriter(); },
  };
}

/**
 * Run `body` — the source of an async function body over `{ lc, cm, V }` — in a FRESH process that is a
 * starting server on the current CLAUDE_STATION_DATA: with an authority it takes the data dir's claim and
 * runs boot recovery first, exactly as a restarted server does (so work still running in a container is
 * found and protected). The caller must not hold the claim itself. Returns the body's JSON result.
 */
export async function runAsServerProcess(treeRoot, body, vars = {}) {
  const { spawnSync } = await import('node:child_process');
  const lcFile = path.join(treeRoot, 'src', 'server', 'lifecycle.ts');
  const code = `const lc = ${fs.existsSync(lcFile) ? `await import(${JSON.stringify(lcFile)})` : 'null'};
if (lc) await lc.bootForTests();
const cm = await import(${JSON.stringify(path.join(treeRoot, 'src', 'server', 'container-manager.ts'))});
const V = ${JSON.stringify(vars)};
let out;
try { out = await (async ({ lc, cm, V }) => { ${body} })({ lc, cm, V }); } catch (e) { out = { error: String(e?.code ?? '') + ' ' + String(e?.message ?? e).split('\\n')[0] }; }
console.log('__RESULT__' + JSON.stringify(out ?? null));
process.exit(0);`;
  const r = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env }, timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });
  const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith('__RESULT__'));
  if (!line) return { error: `no result (exit ${r.status}): ${(r.stderr ?? '').slice(-400)}` };
  return JSON.parse(line.slice('__RESULT__'.length));
}
