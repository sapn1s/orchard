/**
 * verify-feat-096-fleet-enabled.mts — the fleet switch, graded PER PROJECT.
 *
 * FEAT-096 phase 3 turned the orchestrator profile ON for every project in the
 * registry. "On" is only worth anything if it means the same four things for
 * each row, so this grades each project SEPARATELY rather than reporting a
 * fleet-wide average:
 *
 *   1. the registry row says enabled, read through the real `registry.ts`;
 *   2. the exact expression `agent-bridge.ts` uses to compose the runtime
 *      config yields `true` for that row (not a re-implementation of it —
 *      `orchestratorProfileOf(project).enabled || undefined`);
 *   3. that project's OWN command shapes are decided correctly by the real
 *      policy: the orchestrating session is refused the shell and the file
 *      tools WITH A REASON IT CAN ACT ON, and the gate/board commands the
 *      working agreement requires still run;
 *   4. a dispatched lane (an `agent_id`-bearing call) keeps the same tools.
 *
 * IT READS THE LIVE REGISTRY AND WRITES NOTHING. No session is started here and
 * nothing costs money — the real-session half is
 * `verify-feat-096-live-sessions.mts`, which is where "the model actually
 * dispatches instead" is observed.
 *
 * On a machine with no registry it SKIPS loudly rather than passing vacuously.
 *
 * Run: npm run verify:feat-096-fleet
 */
import fs from 'node:fs';

import { registryFile } from '../src/lib/paths.ts';
import { listProjects, orchestratorProfileOf, type Project } from '../src/server/registry.ts';
import { decide } from './lib/orchestrator-profile.mjs';

const checks: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean) => { checks.push({ name, ok }); };

if (!fs.existsSync(registryFile())) {
  console.log(`SKIP — no registry at ${registryFile()}; this verifier grades a real fleet, not a fixture.`);
  process.exit(0);
}

const projects = listProjects();
if (projects.length === 0) {
  console.log('SKIP — the registry has no projects to grade.');
  process.exit(0);
}

/**
 * The composition expression from `agent-bridge.ts` (`startSession` →
 * `runtime.start({ orchestratorProfile: … })`), copied verbatim so this asserts
 * on what a launching session would actually be handed.
 */
const composedFlag = (p: Project) => orchestratorProfileOf(p).enabled || undefined;

/** A refusal is only useful if it says WHY and names the way through. */
const actionable = (reason: string | undefined) =>
  !!reason && /Orchestrator tool profile/.test(reason) && /Agent tool/.test(reason);

for (const p of projects) {
  const tag = `${p.id} (${p.isolation})`;
  check(`${tag}: registry row is enabled`, orchestratorProfileOf(p).enabled === true);
  check(`${tag}: the agent-bridge composition hands the runtime the flag`, composedFlag(p) === true);

  // 1 — the orchestrating session is denied the shell, over THIS project's own path.
  const shell = decide({ toolName: 'Bash', toolInput: { command: `rg -n TODO ${p.hostPath}` }, agentId: null });
  check(`${tag}: orchestrator shell search DENIED`, shell.allow === false);
  check(`${tag}: …with a reason it can act on`, actionable(shell.reason));

  // 1b — and denied the file tools.
  const read = decide({ toolName: 'Read', toolInput: { file_path: `${p.hostPath}/README.md` }, agentId: null });
  check(`${tag}: orchestrator Read DENIED`, read.allow === false);
  check(`${tag}: …with a reason it can act on`, actionable(read.reason));
  const cat = decide({ toolName: 'Bash', toolInput: { command: `cat ${p.hostPath}/package.json` }, agentId: null });
  check(`${tag}: a file read wearing a shell head is DENIED too`, cat.allow === false);
  const gitshow = decide({ toolName: 'Bash', toolInput: { command: 'git show HEAD:package.json' }, agentId: null });
  check(`${tag}: a file read wearing a git prefix is DENIED too`, gitshow.allow === false);

  // 2 — a dispatched lane keeps its full toolset. Same calls, with an agent id.
  const laneShell = decide({ toolName: 'Bash', toolInput: { command: `rg -n TODO ${p.hostPath}` }, agentId: 'a-lane-1' });
  const laneRead = decide({ toolName: 'Read', toolInput: { file_path: `${p.hostPath}/README.md` }, agentId: 'a-lane-1' });
  check(`${tag}: a dispatched lane keeps Bash`, laneShell.allow === true);
  check(`${tag}: a dispatched lane keeps Read`, laneRead.allow === true);

  // 3 — the role's own surface survives: dispatch, steer, ask, and the gate the
  // working agreement REQUIRES before a commit.
  check(`${tag}: dispatch is allowed`, decide({ toolName: 'Agent', toolInput: {}, agentId: null }).allow === true);
  check(`${tag}: asking the user is allowed`, decide({ toolName: 'AskUserQuestion', toolInput: {}, agentId: null }).allow === true);
  check(`${tag}: the pre-commit gate still runs`, decide({ toolName: 'Bash', toolInput: { command: 'npm run gate' }, agentId: null }).allow === true);
  check(`${tag}: board bookkeeping still runs`, decide({ toolName: 'Bash', toolInput: { command: 'npm run board:gen && npm run board:check' }, agentId: null }).allow === true);
  check(`${tag}: its own commit still runs`, decide({ toolName: 'Bash', toolInput: { command: 'git add -A && git commit -m "board: note"' }, agentId: null }).allow === true);
}

/*
 * The COST this ticket promised to report rather than discover: a command that
 * mixes the gate with a file read in one call is refused as a whole. That is
 * the shape the orchestrator has to split, and it is asserted here so the tax
 * stays visible instead of turning into a mystery refusal.
 */
const mixed = decide({
  toolName: 'Bash',
  toolInput: { command: "npm run board:check; sed -n '33,37p' docs/bugs/INDEX.md" },
  agentId: null,
});
check('the known cost: gate/board mixed with a file read in ONE call is refused (split it)', mixed.allow === false);
check('…and the refusal names the read, so the split is obvious', /sed/.test(mixed.reason ?? ''));

const failed = checks.filter((c) => !c.ok);
const byProject = projects.length;
for (const c of failed) console.log(`  FAIL  ${c.name}`);
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} — ${checks.length - failed.length}/${checks.length} checks across ${byProject} projects (${projects.filter((p) => p.isolation === 'container').length} containerised)`);
process.exit(failed.length === 0 ? 0 : 1);
