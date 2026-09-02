/**
 * verify-orchestrator-enforcement-e2e.mts — FEAT-096 phase 2, END TO END.
 *
 * Drives the REAL `ClaudeRuntime` — the module the enforcement hook was added
 * to, not a reconstruction of it — with the profile off and then on, and
 * asserts on WHAT THE USER SEES rather than on the config.
 *
 * SEPARATE FROM `verify:orchestrator-enforcement` AND NOT PART OF THE GATE,
 * deliberately: this one starts four real model sessions, so it costs money and
 * needs credentials. The pure-policy suite runs free and is the one to run on
 * every change; this is the one to run before turning the flag on for a project.
 *
 * Run: npm run verify:orchestrator-enforcement-e2e
 */
import { ClaudeRuntime } from '../src/server/runtime/claude-runtime.ts';
import { isolatedStoreEnv } from './lib/station-boot.mjs';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A throwaway tree with one file to find. Never /tmp (project convention). */
const scratch = path.join(os.homedir(), 'scratch', 'orchestrator-e2e');
fs.mkdirSync(scratch, { recursive: true });
fs.writeFileSync(path.join(scratch, 'notes.txt'), 'kenimai reference file\n');

// Isolate the CLI transcript store so these real "kenimai / 391 / SUB_BASH_OK"
// probe sessions land under scratch, not the user's ~/.claude/projects. The
// ClaudeRuntime below inherits process.env, so setting it here reaches the CLI.
// (Creds are symlinked in by isolatedStoreEnv so OAuth still resolves.)
Object.assign(process.env, isolatedStoreEnv(path.join(scratch, 'store')));

type Seen = { text: string[]; tools: { name: string; input: unknown }[]; results: string[] };

async function run(prompt: string, orchestratorProfile: boolean, label: string): Promise<Seen> {
  const rt = new ClaudeRuntime();
  const seen: Seen = { text: [], tools: [], results: [] };
  rt.start({
    cwd: scratch,
    firstPrompt: prompt,
    permissionMode: 'bypassPermissions',
    orchestratorProfile: orchestratorProfile || undefined,
    onApproval: async () => ({ behavior: 'allow', updatedInput: {} }) as never,
  });
  const timer = setTimeout(() => rt.close(), 300_000);
  try {
    for await (const m of rt.messages() as AsyncIterable<any>) {
      if (m.type === 'assistant') {
        for (const b of m.message?.content ?? []) {
          if (b.type === 'text' && b.text.trim()) seen.text.push(b.text);
          if (b.type === 'tool_use') seen.tools.push({ name: b.name, input: b.input });
        }
      }
      if (m.type === 'user') {
        for (const b of (m.message?.content ?? [])) {
          if (b.type === 'tool_result') seen.results.push(JSON.stringify(b.content));
        }
      }
      if (m.type === 'result') break;
    }
  } finally { clearTimeout(timer); rt.close(); }
  console.log(`\n─── ${label} ───`);
  console.log('TOOLS:', seen.tools.map((t) => t.name).join(', ') || '(none)');
  console.log('USER-VISIBLE TEXT:\n' + seen.text.join('\n---\n').slice(0, 1800));
  return seen;
}

const checks: [string, boolean][] = [];
const check = (n: string, c: boolean) => { checks.push([n, c]); console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}`); };

// A — MUST-FAIL PROOF: with the profile OFF (the default), the session runs the
// shell command. This is today's behaviour and the thing being changed.
const off = await run(
  'Search this directory tree for any file mentioning "kenimai". Use a shell command.',
  false, 'A. profile OFF (default) — must still run the command');
check('A: with the profile off, the session DOES run a shell search (the drift reproduces)',
  off.tools.some((t) => t.name === 'Bash'));

// B — the user-visible refusal.
const on = await run(
  'Search this directory tree for any file mentioning "kenimai". Use a shell command.',
  true, 'B. profile ON — must refuse legibly');
const bText = on.text.join('\n');
/*
 * NOTE — this assertion was wrong on its first run and the correction is the
 * point. I first asserted "no Bash result came back at all". It failed, and the
 * policy was right: the orchestrator's OWN Bash was refused, it then dispatched
 * an Explore lane, and THE LANE ran the search with its full toolset. Those lane
 * calls surface on the same message stream under the same session identity —
 * exactly the confusion FEAT-096 warned about. The property that actually
 * matters is that the orchestrator's own call was denied WITH THE REASON
 * DELIVERED, which is what the tool_result proves.
 */
check('B: the orchestrator\'s own Bash call was DENIED with the policy reason delivered to the model',
  on.results.some((r) => /Orchestrator tool profile/.test(r)));
check('B: the delivered denial names the offending command and the remedy',
  on.results.some((r) => /grep/.test(r) && /Agent tool/.test(r)));
check('B: the work still got done — the refusal redirected rather than blocked',
  on.tools.some((t) => t.name === 'Agent'));
check('B: the reply explains it was refused by a policy, not a crash',
  /profile|not available|restricted|refus/i.test(bText));
check('B: the reply names dispatching as the alternative',
  /dispatch|Agent tool|lane|subagent/i.test(bText));
check('B: the reply is not an unexplained error',
  bText.length > 80 && !/^Error/i.test(bText.trim()));

// C — a dispatched worker keeps its full toolset.
const sub = await run(
  'Dispatch a general-purpose subagent (Agent tool) whose entire task is to run the shell command `echo SUB_BASH_OK` using the Bash tool and report the exact output. Report back what it said.',
  true, 'C. profile ON — dispatched lane must keep Bash');
check('C: the orchestrator was allowed to dispatch', sub.tools.some((t) => t.name === 'Agent'));
check('C: the subagent actually ran the command through Bash',
  /SUB_BASH_OK/.test(sub.results.join('') + sub.text.join('')));
check('C: the subagent did NOT report losing its Bash tool',
  !/Bash tool was not available|no Bash tool|Bash.{0,20}not available/i.test(sub.results.join('') + sub.text.join('')));

// D — a restricted session can still answer a question needing no tools.
const noTool = await run(
  'Without using any tool at all, answer in one sentence: what is 17 multiplied by 23?',
  true, 'D. profile ON — a no-tool answer must still work');
check('D: answered with no tool calls', noTool.tools.length === 0);
check('D: the answer is correct (391)', /391/.test(noTool.text.join('')));

const failed = checks.filter(([, c]) => !c);
console.log(`\n${failed.length === 0 ? 'E2E PASS' : 'E2E FAIL'} — ${checks.length - failed.length}/${checks.length}`);
for (const [n] of failed) console.log('  FAILED: ' + n);
process.exit(failed.length === 0 ? 0 : 1);
