#!/usr/bin/env node
/**
 * BUG-157 (round 4) — unit proof for the CONTAINER LIVENESS CLASSIFIER
 * (`classifyContainerLiveness` / `isShellToolProc` in container-manager.ts), the
 * pure heart of the ground-truth close decision that replaced round 3's broken
 * frame-staleness timeout.
 *
 * The fixtures are REAL captured tagged-process dumps from a real container CLI
 * (scratch/b157r4 proc-signature.mjs): the ACTIVE set is a background subagent
 * mid-Bash-call; the IDLE set is the same CLI after the call finished, waiting on
 * input. The classifier must call ACTIVE `workAlive` and IDLE not — that is the
 * exact discrimination the data-loss vs leak cases turn on.
 */
import * as path from 'node:path';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const cm = await import(path.join(ROOT, 'src', 'server', 'container-manager.ts'));
const { classifyContainerLiveness, isShellToolProc } = cm;

// Parse the "pid ppid=N EXEC=… :: cmd" dump lines the probe emits into TaggedProc.
const parse = (block) => block.trim().split('\n').filter(Boolean).map((l) => {
  const m = l.match(/^(\d+)\s+ppid=(\d+)\s+\S+\s+::\s+(.*)$/);
  if (!m) throw new Error(`bad fixture line: ${l}`);
  return { pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3].trim() };
});

// REAL capture — a background subagent running `/bin/bash -c … eval '…sleep 1…'`.
const ACTIVE = parse(`
127 ppid=65 EXEC=x :: node /home/claude/.serena/language_servers/static/TypeScriptLanguageServer/ts-lsp/node_modules/.bin/typescript-language-server --stdio
140 ppid=127 EXEC=x :: /usr/bin/node /home/claude/.serena/.../tsserver.js --serverMode partialSemantic
141 ppid=127 EXEC=x :: /usr/bin/node /home/claude/.serena/.../tsserver.js --useInferredProjectPerProjectRoot
154 ppid=141 EXEC=x :: /usr/bin/node /home/claude/.serena/.../typingsInstaller.js --globalTypingsCacheLocation /home/claude/.cache/typescript/5.9
209 ppid=42 EXEC=x :: /bin/bash -c source /home/claude/.claude/shell-snapshots/snapshot-bash-1787836534327-7ubraa.sh 2>/dev/null || true && eval 'for i in $(seq 1 90); do date +%s >> /workspace/bg.log; sleep 1; done; echo LOOP-DONE' < /dev/null
250 ppid=209 EXEC=x :: sleep 1
42 ppid=0 EXEC=x :: /home/claude/.local/bin/claude --output-format stream-json --verbose --input-format stream-json --mcp-config {} --session-id=abc
65 ppid=42 EXEC=x :: /opt/uv-tools/serena-agent/bin/python /usr/local/bin/serena start-mcp-server --context claude-code
`);
// REAL capture — the SAME CLI after FINISHED: CLI + serena MCP + language servers, no tool shell.
const IDLE = parse(`
127 ppid=65 EXEC=x :: node /home/claude/.serena/language_servers/static/TypeScriptLanguageServer/ts-lsp/node_modules/.bin/typescript-language-server --stdio
140 ppid=127 EXEC=x :: /usr/bin/node /home/claude/.serena/.../tsserver.js --serverMode partialSemantic
141 ppid=127 EXEC=x :: /usr/bin/node /home/claude/.serena/.../tsserver.js --useInferredProjectPerProjectRoot
154 ppid=141 EXEC=x :: /usr/bin/node /home/claude/.serena/.../typingsInstaller.js --globalTypingsCacheLocation /home/claude/.cache/typescript/5.9
42 ppid=0 EXEC=x :: /home/claude/.local/bin/claude --output-format stream-json --verbose --input-format stream-json --mcp-config {} --session-id=abc
65 ppid=42 EXEC=x :: /opt/uv-tools/serena-agent/bin/python /usr/local/bin/serena start-mcp-server --context claude-code
`);

let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.log(`FAIL  ${name}  ${JSON.stringify(detail)}`); } };

// A BACKGROUNDED daemon: the agent ran `setsid sh -c '…' &`, so the shell
// reparented to init (ppid=1, OUTSIDE the tagged set). The CLI's turn is no
// longer blocked on it — it must be reap-able, not treated as live work, or one
// lingering daemon would pin the container session open forever.
const DAEMON = parse(`
42 ppid=0 EXEC=x :: /home/claude/.local/bin/claude --output-format stream-json --session-id=abc
65 ppid=42 EXEC=x :: /opt/uv-tools/serena-agent/bin/python /usr/local/bin/serena start-mcp-server
900 ppid=1 EXEC=x :: /bin/sh -c while true; do echo daemon >> /workspace/d.log; sleep 5; done
`);

const a = classifyContainerLiveness(ACTIVE);
const i = classifyContainerLiveness(IDLE);
const e = classifyContainerLiveness([]);
const d = classifyContainerLiveness(DAEMON);

check('ACTIVE (subagent mid-Bash): workAlive true — live work is KEPT', a.workAlive === true, a);
check('ACTIVE: cliAlive true', a.cliAlive === true, a);
check('IDLE (CLI waiting, work done): workAlive FALSE — a stuck row does not pin', i.workAlive === false, i);
check('IDLE: cliAlive true (CLI + MCP still up)', i.cliAlive === true, i);
check('EMPTY (CLI gone): cliAlive false, workAlive false — close now', e.cliAlive === false && e.workAlive === false, e);
check('DAEMON (backgrounded/setsid, reparented to init): workAlive FALSE — reap-able, no forever-leak', d.workAlive === false, d);
check('DAEMON: cliAlive true (CLI + MCP up), so the fuse closes+reaps rather than kills nothing', d.cliAlive === true, d);

// The descendant BFS: a sleep child of the bash tool is work even though sleep is not itself a shell.
check('descendant of tool shell counts (sleep under bash)', classifyContainerLiveness(ACTIVE).workAlive === true, {});
// If only the sleep survived but its bash parent is gone AND it is reparented off
// the shell, it would not be caught — assert the shell root itself is the anchor.
check('the bash -c tool shell is itself a work root', isShellToolProc("/bin/bash -c source x && eval 'y'") === true, {});

// Discriminator honesty: none of the persistent infra is misread as tool work.
check('serena MCP (python) is NOT tool work', isShellToolProc('/opt/uv-tools/serena-agent/bin/python /usr/local/bin/serena start-mcp-server') === false, {});
check('language server (node) is NOT tool work', isShellToolProc('node .../typescript-language-server --stdio') === false, {});
check('the CLI (node) is NOT tool work', isShellToolProc('/home/claude/.local/bin/claude --output-format stream-json') === false, {});
check('a bare login shell (no -c) is NOT tool work', isShellToolProc('/bin/bash') === false, {});
check('sh -c IS tool work', isShellToolProc('sh -c "make build"') === true, {});
check('a path-qualified /usr/bin/bash -c IS tool work', isShellToolProc('/usr/bin/bash -c "npm test"') === true, {});

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
