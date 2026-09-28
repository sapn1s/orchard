/**
 * FEAT-152 round 4 — drive the ACTUAL PreToolUse callback that
 * `ClaudeRuntime.start()` registers (not the extracted helper), captured at the
 * SDK `query` boundary with node's module mock. Run by
 * verify-feat-152-orch-bypass.mts as a child process:
 *
 *   node --experimental-test-module-mocks wired-hook-probe.mts <orch|plain>
 *   env CLAUDE_STATION_DATA = a scratch data dir (never the real one)
 *
 * Prints ONE JSON line mapping case name → the hook's returned object.
 * Throwing getters on `tool_input` make the pre-profile shared code (git block,
 * Fable gate, file lock) throw INSIDE the callback's outer try — the round-3
 * "registered-runtime-hook" attack.
 */
import fs from 'node:fs';
import path from 'node:path';
import { mock } from 'node:test';

const profile = process.argv[2] === 'orch';
const dir = process.env.CLAUDE_STATION_DATA!;
const repo = fs.mkdtempSync(path.join(dir, 'repo-'));
process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'claude-config');
console.warn = () => {};

let options: any;
mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: { query: (args: any) => { options = args.options; throw new Error('capture SDK boundary'); } },
});
const { ClaudeRuntime } = await import('../../../src/server/runtime/claude-runtime.ts');
const runtime: any = new ClaudeRuntime();
try {
  runtime.start({
    cwd: repo,
    orchestratorProfile: profile,
    gitGrantKey: 'feat152-probe',   // turns the FEAT-129 file-lock path on
    gitRepoPath: repo,
    sessionLabel: 'probe',
    onApproval: async () => ({ behavior: 'allow' }),
  });
} catch (e) {
  if ((e as Error).message !== 'capture SDK boundary') throw e;
}
if (!options) throw new Error('SDK options not captured');
const hook = options.hooks.PreToolUse[0].hooks[0];

const thrower = (field: string) => ({ get [field]() { throw new Error(`injected ${field} getter failure`); } });
const proxy = new Proxy({}, { get() { throw new Error('injected proxy get'); }, has() { throw new Error('injected proxy has'); } });
const GOOD = '# ORCH-BYPASS: need this exact output for the next decision\ncat package.json';

const cases: Record<string, any> = {
  bypass: { tool_name: 'Bash', tool_input: { command: GOOD } },
  deniedPlain: { tool_name: 'Bash', tool_input: { command: 'grep -rn foo /src' } },
  laneBash: { tool_name: 'Bash', tool_input: { command: 'grep -rn x /' }, agent_id: 'agent-probe' },
  bashThrow: { tool_name: 'Bash', tool_input: thrower('command') },
  bashProxyThrow: { tool_name: 'Bash', tool_input: proxy },
  laneBashThrow: { tool_name: 'Bash', tool_input: thrower('command'), agent_id: 'agent-probe' },
  agentThrow: { tool_name: 'Agent', tool_input: thrower('model') },
  // A throw inside the file-lock's own classifier is swallowed THERE (FEAT-129's
  // designed degrade), so it never reaches the callback's catch; a throw in the
  // callback's own owner computation (`i.agent_id`) on the file-lock path does.
  writeThrow: { tool_name: 'Write', tool_input: thrower('file_path') },
  writeOwnerThrow: { tool_name: 'Write', tool_input: { file_path: path.join(repo, 'x.txt'), content: 'x' }, get agent_id() { throw new Error('injected agent_id getter failure'); } },
};
const out: Record<string, any> = {};
for (const [k, input] of Object.entries(cases)) {
  try { out[k] = await hook(input); } catch (e) { out[k] = { threw: (e as Error).message }; }
}
try { runtime.close?.(); } catch { /* best effort */ }
process.stdout.write(JSON.stringify(out) + '\n');
process.exit(0);
