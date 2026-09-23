/**
 * BUG-162 (round 2) — netGit must bound a network op with a REAL timeout AND
 * reap the whole process GROUP, so a hanging remote leaves no orphaned
 * `git-remote-http(s)` grandchild alive.
 *
 * The round-1 fix bounded fetch/push/pull with env de-prompting + curl's
 * http.lowSpeed abort + execFile's `timeout`. That is enough for a pure
 * black-hole (curl aborts the stalled transfer in ~15s and reaps its helper),
 * but NOT for a remote that trickles bytes just ABOVE http.lowSpeedLimit: curl
 * never sees it as "slow", so git rides the full hard timeout, and when
 * execFile's timeout SIGTERMs the direct `git`, its `git-remote-http` grandchild
 * — the process actually holding the socket — is orphaned and keeps running.
 *
 * This drives the REAL exported git.fetch() against BOTH kinds of loopback
 * remote and asserts, for each, that fetch fails AND leaves no live
 * git-remote-http(s) behind. Scenario B (trickle) is the must-FAIL: on round-1
 * code it left exactly one orphan.
 *
 *   node scripts/verify-bug-162-netgit-orphan.mjs
 *
 * Scratch-only, loopback ephemeral ports, no real remote touched. ~75s (the
 * trickle scenario rides the hard-timeout backstop by design).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';

const HARD_CAP_MS = Number(process.env.HARD_CAP_MS ?? 90_000); // fetch must return under this

function sh(cmd, args, cwd) { execFileSync(cmd, args, { cwd, stdio: 'pipe' }); }
function liveHelpers() {
  const r = spawnSync('pgrep', ['-fa', 'git-remote-http'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim().split('\n').filter(Boolean) : [];
}

// A: pure black hole — accept the TCP connection, never answer anything.
function blackHole() { return net.createServer((s) => { s.on('error', () => {}); }); }
// B: trickle — send an HTTP-ish header then dribble ~2KB/500ms (>1000 B/s), so
//    curl's low-speed timer never fires and git rides the hard timeout.
function trickle() {
  return net.createServer((s) => {
    s.on('error', () => {});
    s.write('HTTP/1.1 200 OK\r\nContent-Type: application/x-git-upload-pack-advertisement\r\nContent-Length: 100000000\r\n\r\n');
    const iv = setInterval(() => { try { s.write('x'.repeat(2000)); } catch { clearInterval(iv); } }, 500);
    s.on('close', () => clearInterval(iv));
  });
}

async function scenario(name, makeServer) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bug162-netgit-'));
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  const srv = makeServer();
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const port = srv.address().port;
  sh('git', ['init', '-q'], repo);
  sh('git', ['-C', repo, 'config', 'user.email', 'x@y.z']);
  sh('git', ['-C', repo, 'config', 'user.name', 'x']);
  sh('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init']);
  sh('git', ['-C', repo, 'remote', 'add', 'origin', `http://127.0.0.1:${port}/repo.git`]);

  const before = liveHelpers();
  const { fetch } = await import('../src/server/git.ts');
  const t0 = Date.now();
  let failed = false, reason = '';
  try { await fetch(repo); } catch (e) { failed = true; reason = String(e?.message ?? e); }
  const elapsed = Date.now() - t0;
  await new Promise((r) => setTimeout(r, 800));
  const leaked = liveHelpers().filter((l) => !before.includes(l));
  srv.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  for (const l of leaked) { const pid = Number(l.split(/\s+/)[0]); if (pid > 0) try { process.kill(pid, 'SIGKILL'); } catch {} }

  const boundOk = failed && elapsed < HARD_CAP_MS;
  const noOrphan = leaked.length === 0;
  console.log(`[${name}] failed=${failed} elapsed=${elapsed}ms leaked=${leaked.length}  bound=${boundOk ? 'PASS' : 'FAIL'} orphan=${noOrphan ? 'PASS' : 'FAIL'}`);
  console.log(`         reason: ${reason.slice(0, 110)}`);
  for (const l of leaked) console.log(`         ORPHAN: ${l}`);
  return boundOk && noOrphan;
}

async function main() {
  const a = await scenario('A black-hole', blackHole);
  const b = await scenario('B trickle   ', trickle);
  const pass = a && b;
  console.log(pass ? '\nRESULT: PASS (2/2)' : '\nRESULT: FAIL');
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
