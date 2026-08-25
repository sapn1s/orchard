/**
 * FEAT-039 gap #1 — LIVE launch-path verification.
 *
 *   node scripts/verify-conventions-live.mjs
 *
 * scripts/verify-local-conventions.mjs already proves the COMPOSE layer
 * (templates.ts's composeInstructions(refs, { hostPath })) is wired correctly
 * in isolation. It does NOT prove a real launched session actually receives
 * that content — the real launch call site is `src/server/agent-bridge.ts`'s
 * `AgentSession` constructor (`this.composed = composeInstructions(refs, {
 * hostPath: opts.project.hostPath })`), reached via the REAL `startSession()`
 * entry point that `src/server/index.ts`'s WS `'start'` handler calls for
 * every session a user launches from the dashboard.
 *
 * This script calls that REAL `startSession()` — no mocks, no stubbed
 * ClaudeRuntime — for two real registry projects (one with docs/CONVENTIONS.md,
 * one without) and reads the actual `AgentSession.composed` field the
 * constructor produced, which is the exact value `#run()`'s `let sp =
 * this.composed.systemPrompt` (agent-bridge.ts) folds the live board section
 * onto and hands to the CLI. Sessions are closed immediately after that field
 * is read, before any real turn/API cost accrues beyond the CLI spawn itself.
 *
 * Isolation 'direct', no container, no browser, no snapshots, no survival —
 * none of those subsystems engage for this project shape, so this is a plain
 * in-process spawn of the real `claude` CLI child process.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-convlive-data-'));
const WITH = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-convlive-with-'));
const WITHOUT = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-convlive-none-'));

process.env.CLAUDE_STATION_DATA = DATA;

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}
const appendOf = (sp) => (typeof sp === 'string' ? sp : sp && typeof sp === 'object' ? sp.append : '');

async function launchAndRead(reg, agentBridge, project) {
  const events = [];
  let session = null;
  try {
    session = await agentBridge.startSession({
      project,
      firstPrompt: 'Reply with exactly: ok. Do not use any tools.',
      onEvent: (e) => events.push(e),
    });
    // The constructor has already returned by the time startSession() resolves
    // — `composed` was assigned synchronously in the constructor BEFORE the
    // runtime spawn call, so this is the real value the launch used, not a
    // race against the CLI's async work.
    return { composed: session.composed, events };
  } finally {
    if (session) await session.close('verify-conventions-live done').catch(() => {});
  }
}

async function main() {
  fs.mkdirSync(path.join(WITH, 'docs'), { recursive: true });
  fs.writeFileSync(
    path.join(WITH, 'docs', 'CONVENTIONS.md'),
    '# Local rules\n\n- This project deploys via `deploy.sh`, never manually.\n- Staging DB lives at db.internal:5432.\n',
  );
  fs.writeFileSync(path.join(WITHOUT, 'README.md'), '# no local conventions doc here\n');

  const tpl = await import(path.join(ROOT, 'src', 'server', 'templates.ts'));
  const reg = await import(path.join(ROOT, 'src', 'server', 'registry.ts'));
  const agentBridge = await import(path.join(ROOT, 'src', 'server', 'agent-bridge.ts'));

  tpl.seedTemplates();

  const pWith = reg.createProject({
    name: 'convlive-with',
    hostPath: WITH,
    isolation: 'direct',
    settings: { model: 'haiku', instructions: [{ templateId: 'working-agreement-v2' }] },
  });
  const pWithout = reg.createProject({
    name: 'convlive-without',
    hostPath: WITHOUT,
    isolation: 'direct',
    settings: { model: 'haiku', instructions: [{ templateId: 'working-agreement-v2' }] },
  });

  console.log('\n=== REAL launch (startSession -> AgentSession constructor), project WITH docs/CONVENTIONS.md ===');
  const withResult = await launchAndRead(reg, agentBridge, pWith);
  const withAppend = appendOf(withResult.composed.systemPrompt);
  check('REAL LAUNCH: composed.appliedIds includes "local-conventions" for a project WITH docs/CONVENTIONS.md',
    withResult.composed.appliedIds.includes('local-conventions'), withResult.composed.appliedIds);
  check('REAL LAUNCH: the injected system prompt actually contains the local-doc content',
    withAppend.includes('deploy.sh') && withAppend.includes('db.internal:5432'), withAppend.slice(-500));
  check('REAL LAUNCH: the shared Working Agreement content is still present (addendum, not replacement)',
    withAppend.includes('# Working Agreement v2'), 'WA header present=' + withAppend.includes('# Working Agreement v2'));
  console.log('\n  --- observed injected snippet (tail of the REAL composed systemPrompt) ---');
  console.log(withAppend.slice(withAppend.indexOf('Project Conventions (local)') - 40).slice(0, 400).split('\n').map((l) => `  | ${l}`).join('\n'));

  console.log('\n=== REAL launch, project WITHOUT docs/CONVENTIONS.md ===');
  const withoutResult = await launchAndRead(reg, agentBridge, pWithout);
  const withoutAppend = appendOf(withoutResult.composed.systemPrompt);
  check('REAL LAUNCH: composed.appliedIds does NOT include "local-conventions" for a project with no doc',
    !withoutResult.composed.appliedIds.includes('local-conventions'), withoutResult.composed.appliedIds);
  check('REAL LAUNCH: no "Project Conventions (local)" section leaks into a doc-less project, and the WA still applied (no error)',
    !withoutAppend.includes('Project Conventions (local)') && withoutAppend.includes('# Working Agreement v2'),
    'clean, no error events: ' + withoutResult.events.filter((e) => e.t === 'error').length + ' error event(s)');

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.stack ?? err.message}`);
  process.exitCode = 1;
}).finally(async () => {
  // Best-effort: close-all in case a session survived an early throw.
  try {
    const agentBridge = await import(path.join(ROOT, 'src', 'server', 'agent-bridge.ts'));
    await agentBridge.closeAllSessions('verify-conventions-live cleanup').catch(() => {});
  } catch { /* module may not have loaded */ }
  for (const d of [DATA, WITH, WITHOUT]) fs.rmSync(d, { recursive: true, force: true });
});
