/**
 * FEAT-154 (round 5) — the OWNER-LEVEL "working" fact.
 *
 *   node scripts/verify-feat-154-working-fact.mjs
 *
 * The reported defect: session 4ea3d0d2 showed a green (finished) circle while a
 * background SUBAGENT was still running — because the list read only the
 * per-bridge `running` verdict (main turn only), which is false once the main
 * turn ends. The fix declares ONE owner fact in src/server/liveness.ts:
 * `working` = a MAIN turn in flight OR a live subagent/background lane. This
 * tests it directly against the REAL authority with BridgeLike stubs shaped like
 * the real 4ea3d0d2 verdict (alive process, busy:false, a live background lane),
 * plus the round-3 idle-alive control (no lane ⇒ NOT working). No browser, no
 * server: this is the owner's own answer.
 *
 * MUST-FAIL: pre-fix, `livenessOfBridge` had no `working` field and `livenessWire`
 * never published one, so the idle+live-lane case has `working === undefined`
 * (not true) and the wire omits it — the two must-FAIL checks reddened.
 */
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const { livenessOfBridge, livenessWire } = await import(path.join(ROOT, 'src', 'server', 'liveness.ts'));

let pass = 0, fail = 0; const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}

const now = Date.now();
const aliveProbe = () => ({ state: 'alive', detail: 'broker pid 4123219 and CLI pid 4123226 are alive (broker state running)' });
const deadProbe = () => ({ state: 'dead', detail: 'the agent CLI (pid 4123226) is gone' });

// The REAL 4ea3d0d2 shape: alive process, main turn ENDED (busy:false), a live
// background subagent lane still running.
const idleWithLiveSubagent = {
  closed: false, busy: false, lastFrameAt: now - 40_000, turnStartedAt: null,
  processProbe: aliveProbe, hasLiveBackgroundLane: () => true, hasLiveBackgroundAgent: () => true, hasMainThreadWork: () => false,
};
// Round-3 control: alive process, idle, NO live lane.
const idleAliveNoLane = {
  closed: false, busy: false, lastFrameAt: now - 20 * 3600_000, turnStartedAt: null,
  processProbe: aliveProbe, hasLiveBackgroundLane: () => false, hasLiveBackgroundAgent: () => false, hasMainThreadWork: () => false,
};
// A genuine running MAIN turn.
const runningMain = {
  closed: false, busy: true, lastFrameAt: now - 1_000, turnStartedAt: now - 5_000,
  processProbe: aliveProbe, hasMainThreadWork: () => true, hasLiveBackgroundLane: () => false,
};
// A DEAD process that still carries a leftover lane record — must NOT resurrect.
const deadWithLaneRecord = {
  closed: false, busy: true, lastFrameAt: now - 5_000, turnStartedAt: now - 10_000,
  processProbe: deadProbe, hasLiveBackgroundLane: () => true, hasLiveBackgroundAgent: () => true, hasMainThreadWork: () => false,
};

const vSub = livenessOfBridge(idleWithLiveSubagent, now);
check('REAL 4ea3d0d2 shape: main turn ended (running=false) but a live subagent ⇒ working=TRUE (must-FAIL pre-fix: undefined)',
  vSub.running === false && vSub.working === true, { running: vSub.running, working: vSub.working, kind: vSub.kind });

const vIdle = livenessOfBridge(idleAliveNoLane, now);
check('round-3 guarantee kept: idle-alive bridge, NO live lane ⇒ working=false (not running)',
  vIdle.running === false && vIdle.working === false, { running: vIdle.running, working: vIdle.working });

const vRun = livenessOfBridge(runningMain, now);
check('a running MAIN turn ⇒ working=true',
  vRun.running === true && vRun.working === true, { running: vRun.running, working: vRun.working });

const vDead = livenessOfBridge(deadWithLaneRecord, now);
check('a DEAD process with a leftover lane record ⇒ working=false (live:false gate; not resurrected)',
  vDead.live === false && vDead.working === false, { live: vDead.live, working: vDead.working, kind: vDead.kind });

// ── round 6 ── REAL 7f7e39a1 shape (broker status record, 2026-09-29): alive
// broker+CLI, busy:false, the level lists FIVE local_bash lanes (never-ending
// `until grep … ; do sleep` pollers) and NO agent. And REAL 4846de18: one
// local_bash lane (a dev server). Both keep the process alive; neither is an agent.
const shellsOnly = (n) => ({
  closed: false, busy: false, lastFrameAt: now - 36 * 3600_000, turnStartedAt: null,
  processProbe: aliveProbe, hasLiveBackgroundLane: () => n > 0, hasLiveBackgroundAgent: () => false, hasMainThreadWork: () => false,
});
const v7f = livenessOfBridge(shellsOnly(5), now);
check('round 6 (REAL 7f7e39a1 shape): 5 background shell pollers, no agent ⇒ working=FALSE (must-FAIL on round 5: true)',
  v7f.live === true && v7f.running === false && v7f.working === false, { live: v7f.live, running: v7f.running, working: v7f.working });
const v48 = livenessOfBridge(shellsOnly(1), now);
check('round 6 (REAL 4846de18 shape): a background dev server only ⇒ working=FALSE (must-FAIL on round 5: true)',
  v48.working === false, { working: v48.working });
// Synthesized PRE-FIX formula (round 5, anchored here, not to a moving revision):
// working = running || (live && hasLiveBackgroundLane()). On the same stub it is TRUE,
// which is the reported false "running" — proving the two checks above are not vacuous.
const round5 = (b, v) => v.running || (v.live && b.hasLiveBackgroundLane());
check('round 6 must-FAIL sentinel: the round-5 formula on the 7f7e39a1 shape IS true (the reported bug)',
  round5(shellsOnly(5), v7f) === true, { round5: round5(shellsOnly(5), v7f) });
// A bridge that does not declare the agent fact at all must not be read as working.
const legacy = { ...shellsOnly(5) }; delete legacy.hasLiveBackgroundAgent;
const vLeg = livenessOfBridge(legacy, now);
check('round 6: a source that declares no hasLiveBackgroundAgent ⇒ lanes do not count (working=false, never inferred from hasLiveBackgroundLane)',
  vLeg.working === false, { working: vLeg.working });

const wire = livenessWire(vSub);
check('livenessWire PUBLISHES working (must-FAIL pre-fix: field absent)',
  wire.working === true, { working: wire.working });

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) console.log(`failed: ${failures.join(' | ')}`);
process.exitCode = fail ? 1 : 0;
