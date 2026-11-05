#!/usr/bin/env node
/**
 * FEAT-199 r12 (PART A) — lane CPU deprioritisation is CALLER-DECLARED, never
 * applied to every persisted session.
 *
 * The refuted r12 (anthropic run d542dc75) put `--property=CPUWeight=20` on EVERY
 * survivable scope unconditionally. `spawnSurvivable` also backs the user's OWN
 * dashboard sessions, so that deprioritised the user's own work. The fix: the
 * caller passes `meta.lowPriority`, and the bridge sets it only for an
 * agent/lane-started session (`#startedBy === 'agent'`). A user session is
 * launched at the scope's default weight (the `--property` is simply omitted).
 *
 * This drives the REAL `spawnSurvivable` through REAL `systemd-run --user
 * --scope` under a SCRATCH data dir (CLAUDE_STATION_DATA — isolated mode, so the
 * hosts are named `claude-station-host-t-*` and can never collide with the live
 * service's `-h-*` hosts), then reads the scope's ACTUAL `CPUWeight` via
 * `systemctl --user show`. The live :4317 server is never touched.
 *
 *   PHASE FAIL — a reconstruction of the refuted r12 (always-append) is run with
 *     a USER-session meta and MUST produce CPUWeight=20 (proves the bug was real
 *     and the proof non-vacuous).
 *   PHASE USER — the CURRENT code with a user-session meta (lowPriority omitted)
 *     MUST NOT produce CPUWeight=20 — the scope keeps systemd's default.
 *   PHASE LANE — the CURRENT code with lowPriority:true MUST produce CPUWeight=20.
 *   PHASE BRIDGE — the agent-bridge call site maps `#startedBy === 'agent'` to
 *     lowPriority (static source assertion, so the wiring itself is graded).
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const SURVIVAL = path.join(ROOT, 'src', 'server', 'survival.ts');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  const line = typeof observed === 'string' ? observed : JSON.stringify(observed);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${line}`);
  ok ? pass++ : (fail++, failures.push(name));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'feat199-r12-'));
const DATA = path.join(SCRATCH, 'data');
fs.mkdirSync(DATA, { recursive: true });
process.env.CLAUDE_STATION_DATA = DATA; // isolated data-dir mode → host keys 't-*'

// A stub "CLI" the broker will spawn: stays alive so the scope exists to inspect.
const STUB = path.join(SCRATCH, 'stub.mjs');
fs.writeFileSync(STUB, `setInterval(() => {}, 1e9); process.stdin.resume();\n`);

// Reconstruct the refuted r12 (always-append CPUWeight) as a sibling module so
// its relative imports (./outcomes.ts, ./liveness.ts, ./request-floor.mjs …)
// resolve. It is the CURRENT file with the conditional spread forced always-on.
const R12 = path.join(ROOT, 'src', 'server', 'survival.R12PROOF.ts');
function buildR12() {
  const src = fs.readFileSync(SURVIVAL, 'utf8');
  const needle = "...(meta.lowPriority ? [`--property=CPUWeight=${LANE_CPU_WEIGHT}`] : []),";
  if (!src.includes(needle)) throw new Error('could not find the conditional spread to reconstruct r12 from');
  const r12 = src.replace(needle, "`--property=CPUWeight=${LANE_CPU_WEIGHT}`,");
  fs.writeFileSync(R12, r12);
}

const scopesToStop = new Set();
function stopScope(key) {
  if (!key) return;
  spawnSync('systemctl', ['--user', 'stop', `claude-station-host-${key}.scope`], { timeout: 8000 });
}
function cpuWeightOf(key) {
  const r = spawnSync('systemctl', ['--user', 'show', `claude-station-host-${key}.scope`, '-p', 'CPUWeight', '--value'], { encoding: 'utf8', timeout: 8000 });
  return (r.stdout || '').trim();
}

async function launchAndRead(mod, meta, label) {
  const survival = await import(pathToFileURL(mod).href + `?t=${Date.now()}`);
  if (!survival.survivalEnabled()) throw new Error('survivalEnabled() is false — cannot run this proof here');
  const { proc, handle } = survival.spawnSurvivable(
    { command: process.execPath, args: [STUB], cwd: SCRATCH, env: { ...process.env } },
    meta,
  );
  scopesToStop.add(handle.hostKey);
  // Wait for the scope to come up (its CPUWeight is readable only once active).
  let weight = '';
  for (let i = 0; i < 100; i++) {
    weight = cpuWeightOf(handle.hostKey);
    if (weight && weight !== '[not set]') break;
    // default shows as a large sentinel / the inherited value; break once the
    // unit is active either way.
    const active = spawnSync('systemctl', ['--user', 'is-active', `claude-station-host-${handle.hostKey}.scope`], { encoding: 'utf8', timeout: 5000 }).stdout.trim();
    if (active === 'active') { weight = cpuWeightOf(handle.hostKey); break; }
    await sleep(100);
  }
  try { proc.kill('SIGKILL'); } catch {}
  try { handle.reap(); } catch {}
  await sleep(200);
  stopScope(handle.hostKey);
  console.log(`        [${label}] scope=claude-station-host-${handle.hostKey}.scope CPUWeight=${JSON.stringify(weight)}`);
  return weight;
}

async function main() {
  console.log('FEAT-199 r12 — caller-declared lane CPU deprioritisation\n');
  buildR12();
  try {
    console.log('PHASE FAIL — refuted r12 (always-append) deprioritises a USER session (must reproduce the bug)');
    const wFail = await launchAndRead(R12, { stationSessionId: 'r12-fail-user' }, 'r12/user');
    check('refuted r12 gives a USER session CPUWeight=20 (the refuted bug)', wFail === '20', `CPUWeight=${wFail}`);

    console.log('\nPHASE USER — current code, user session (lowPriority omitted) → NOT 20');
    const wUser = await launchAndRead(SURVIVAL, { stationSessionId: 'cur-user' }, 'cur/user');
    check('current code: a USER session is NOT CPUWeight=20', wUser !== '20', `CPUWeight=${wUser}`);

    console.log('\nPHASE LANE — current code, lane session (lowPriority:true) → 20');
    const wLane = await launchAndRead(SURVIVAL, { stationSessionId: 'cur-lane', lowPriority: true }, 'cur/lane');
    check('current code: a LANE session IS CPUWeight=20', wLane === '20', `CPUWeight=${wLane}`);

    console.log('\nPHASE BRIDGE — the call site maps #startedBy to lowPriority');
    const bridge = fs.readFileSync(path.join(ROOT, 'src', 'server', 'agent-bridge.ts'), 'utf8');
    check("agent-bridge passes lowPriority: this.#startedBy === 'agent'",
      /lowPriority:\s*this\.#startedBy\s*===\s*'agent'/.test(bridge),
      bridge.split('\n').find((l) => l.includes('lowPriority:'))?.trim() ?? '<not found>');
  } finally {
    for (const k of scopesToStop) stopScope(k);
    try { fs.rmSync(R12, { force: true }); } catch {}
    try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
  if (fail) { console.log('failures:', failures.join('; ')); process.exit(1); }
}
main().catch((e) => { try { fs.rmSync(R12, { force: true }); } catch {}; console.error(e); process.exit(1); });
