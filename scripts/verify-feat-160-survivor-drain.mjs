#!/usr/bin/env node
/**
 * FEAT-160 round 2 — switch-account must NOT strand or mis-bill in-flight work.
 *
 * Independent clean-room verify (dispatch anthropic run 03b6751b, VERDICT: BROKEN)
 * found: the `switch-account` handler gated ONLY on `session.busy`, which is
 * TURN-scoped (ARCH-002). If the main turn is idle but a BACKGROUND lane/subagent
 * (or a surviving broker) is still draining under account A, the switch acked ok and
 * reaped — then the client's next `start{resumeSessionId, overrides:{claudeAccount:C}}`
 * was delivered to the OLD account-A CLI (deliveredVia "survivor"), so the turn billed
 * the old subscription while the UI showed C. Adversarial cases the verifier ran:
 *   survivor-drain-switch-bills-old-account (33a48d636150)
 *   live-ws-bad-switches-double-switch-concu (b20846a9f02b)
 *
 * The fix: the handler asks the SAME "does work outlive this turn" authority every
 * other close decision asks — `AgentSession.closeLifetime()` (the broker's own answer
 * for a survivable DIRECT session) — and refuses on anything but a settled `no`.
 *
 * This is the REAL reproduction: a real isolated server, real AgentSession, real
 * DIRECT survival broker (systemd-run --user), only the `claude` model process is the
 * shared scripted fake (scripts/fixtures/bug-187/fake-cli.mjs, command-driven). It
 * uses the BUG-187 harness so the FEAT-151 "runtime-check-pending" start retry and the
 * broker lifecycle are handled correctly.
 *
 * SCENARIOS (each its own world: free port, scratch CLAUDE_STATION_DATA + store):
 *   drain — turn 1 dispatches a background lane and ENDS the turn (busy clears; the
 *           broker's lifetime is 'yes'). A switch-account to a READY account on the
 *           still-attached, idle socket must be REFUSED (ok:false, naming background
 *           work), the OLD session + CLI left ALIVE. PRE-FIX (busy-only gate): ok:true,
 *           the CLI reaped while its background lane was still live under account A.
 *   idle  — NON-VACUITY: turn 1 ends with NO background work. A switch-account to the
 *           SAME ready account must SUCCEED (ok:true) and reap the CLI. Proves the gate
 *           is not vacuously always-refusing — a clean idle session still switches.
 *
 * The account is minted READY with a stub credential so the switch passes validation
 * and the drain refusal is SPECIFICALLY the background-work gate (not a validation
 * refusal — which would make the drain pass vacuously).
 *
 * SAFETY: free ephemeral port, scratch dataDir + store + cwd, every process (survival
 * brokers included) killed BY PID via the harness. :4317 / the real service / scopes
 * not ours are never touched.
 *
 * Run: node scripts/verify-feat-160-survivor-drain.mjs
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ROOT, sleep, pidAlive, makeWorld, bootServer, registerProject, startFakeSession,
  waitFor, hostFor, cleanupWorld,
} from './lib/bug-187-harness.mjs';

/* A scratch HOME so account-overlay materialisation never touches the real ~/.claude. */
const SCRATCH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'feat160sd-home-'));
fs.mkdirSync(path.join(SCRATCH_HOME, '.claude', 'projects'), { recursive: true });
fs.writeFileSync(path.join(SCRATCH_HOME, '.claude', 'settings.json'), JSON.stringify({ cleanupPeriodDays: 36500 }, null, 2) + '\n');
delete process.env.CLAUDE_CONFIG_DIR;
process.env.HOME = SCRATCH_HOME;

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  const line = typeof observed === 'string' ? observed : JSON.stringify(observed);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${line}`);
  ok ? pass++ : (fail++, failures.push(name));
}

/** Mint a READY, credentialled account inside this world's data dir. */
async function mintReadyAccount(w, label) {
  process.env.CLAUDE_STATION_DATA = w.data; // accountsFile()/resolveAccountDir() read env per call
  const accts = await import(path.join(ROOT, 'src', 'server', 'claude-accounts.ts'));
  const row = accts.createAccount(label);
  const file = path.join(w.data, 'claude-accounts.json');
  const reg = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const r of reg.accounts) if (r.id === row.id) r.state = 'ready';
  fs.writeFileSync(file, JSON.stringify(reg, null, 2) + '\n');
  fs.writeFileSync(path.join(accts.resolveAccountDir(row.id), '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'stub' } }) + '\n');
  return row.id;
}

const worlds = [];
async function runScenario(scenario) {
  const w = makeWorld(`feat160sd-${scenario}`);
  worlds.push(w);
  const account = await mintReadyAccount(w, `switch-target-${scenario}`);
  // FAKE_IGNORE_EOF mirrors the real CLI: it stays alive after a stdin-EOF while a
  // background lane is live — so a wrong reap (pre-fix) is observable, not masked.
  const srv = await bootServer(w, { FAKE_IGNORE_EOF: '1' });
  const projectId = await registerProject(srv, w);

  // Turn 1: the `drain` scenario dispatches a background lane via a prompt directive;
  // the lane outlives the turn. `idle` ends with nothing running.
  const prompt = scenario === 'drain'
    ? 'go [[fake:{"op":"lane_start","id":"laneA","type":"local_agent"}]]'
    : 'go';
  const { c, station, cli } = await startFakeSession(srv, w, projectId, prompt);
  // Wait for the turn to end (busy clears) and the broker lifetime to settle.
  const ended = await waitFor(() => c.events.find((e) => e.t === 'turn-end'), 60_000);
  if (!ended) throw new Error(`${scenario}: turn never ended`);
  await sleep(1800);

  const bgIds = (hostFor(w, station)?.backgroundTaskIds ?? []);
  // Fire switch-account on the SAME, still-attached, now-idle socket.
  c.send({ type: 'switch-account', requestId: `sw-${scenario}`, account });
  const ack = await waitFor(() => c.events.find((e) => e.t === 'ack' && e.of === 'switch-account'), 15_000);

  await sleep(2500);
  const h = await (await fetch(`http://127.0.0.1:${srv.port}/api/health`)).json().catch(() => null);
  const openAfter = (h?.sessions ?? []).some((x) => x.stationSessionId === station);
  let cliDead = cli == null || !pidAlive(cli);
  if (scenario === 'idle') { const d = Date.now() + 25_000; while (!cliDead && Date.now() < d) { cliDead = !pidAlive(cli); await sleep(500); } }

  return { scenario, station, cli, bgIds, ack, openAfter, cliDead };
}

async function main() {
  if (spawnSync('systemd-run', ['--version'], { encoding: 'utf8' }).status !== 0) {
    console.error('FATAL: needs `systemd-run --user` — the DIRECT survival broker is the authority under test.');
    process.exitCode = 1; return;
  }

  console.log('\n=== SCENARIO drain: a live background lane under the old account must REFUSE the switch ===');
  const d = await runScenario('drain');
  check('[drain] PRECONDITION: the background lane is live on the broker record (closeLifetime will be non-"no")',
    Array.isArray(d.bgIds) && d.bgIds.includes('laneA'), { backgroundTaskIds: d.bgIds, cli: d.cli });
  // THE DISCRIMINATOR (must-FAIL on the round-1 busy-only gate): the switch is REFUSED.
  check('[drain] the switch-account was REFUSED (ok:false) while background work drains under the old account',
    d.ack != null && d.ack.ok === false, d.ack);
  check('[drain] the refusal NAMES the still-running background work (the gate, not a validation refusal)',
    d.ack != null && /background work is still running/i.test(d.ack.error ?? ''), d.ack?.error);
  check('[drain] the OLD session is still open after the refused switch (not reaped)', d.openAfter === true, { openAfter: d.openAfter });
  check('[drain] the OLD CLI is still ALIVE after the refused switch (background work not stranded)', d.cliDead === false, { cli: d.cli, cliDead: d.cliDead });

  console.log('\n=== SCENARIO idle: NON-VACUITY — a clean idle session still switches ok and reaps ===');
  const i = await runScenario('idle');
  check('[idle] the switch-account SUCCEEDED (ok:true) on a session with no work outliving the turn', i.ack != null && i.ack.ok === true, i.ack);
  check('[idle] the switch-account ack carries the target account', i.ack != null && typeof i.ack.account === 'string', i.ack);
  check('[idle] the OLD CLI was reaped by the accepted switch (the gate is not vacuously always-refusing)', i.cliDead === true, { cli: i.cli, cliDead: i.cliDead });

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.stack ?? err.message}`);
  process.exitCode = 1;
}).finally(async () => {
  for (const w of worlds) { try { await cleanupWorld(w); } catch { /* best effort */ } }
  try { fs.rmSync(SCRATCH_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
  setTimeout(() => process.exit(process.exitCode ?? 0), 500);
});
