/**
 * FEAT-152 round 4 — ONE concurrent bypass writer, run as its OWN PROCESS (a
 * separate orchestrator session) by verify-feat-152-orch-bypass.mts.
 *
 *   node concurrent-writer.mts <real|round3> <sessionId> <K> <goFile>
 *   env CLAUDE_STATION_DATA = the shared scratch data dir
 *
 * Every `fs.writeSync` is forced SHORT (<= CHUNK bytes) with a 1 ms pause
 * between chunks — the multi-syscall write the round-3 refutation exploited —
 * so N of these racing against one ledger interleave for real. Waits on
 * <goFile> so all writers start together. Prints one JSON line: the decisions.
 *   real   → drives the REAL hook path (`evaluateOrchestratorProfileHook` +
 *            `makeOrchBypassRecorder`) exactly as the PreToolUse callback does.
 *   round3 → the pinned round-3 writer (round3-recorder.mts), the must-FAIL
 *            baseline.
 */
import fs from 'node:fs';

const [mode, sessionId, kArg, goFile] = process.argv.slice(2);
const K = Number(kArg);
const CHUNK = 16;
const dataDir = process.env.CLAUDE_STATION_DATA!;
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

console.warn = () => {};
const realWrite = fs.writeSync;
(fs as any).writeSync = (fd: number, buf: any, off?: number, len?: number, pos?: any) => {
  const n = realWrite(fd, buf, off ?? 0, Math.min(CHUNK, len ?? buf.length), pos ?? null);
  sleep(1);
  return n;
};

// A long reason forces many chunks per row (the round-3 multi-syscall path).
const reason = `need session ${sessionId} output for my next decision ` + 'r'.repeat(300);
const command = `# ORCH-BYPASS: ${reason}\ncat package.json`;

const deadline = Date.now() + 20_000;
while (!fs.existsSync(goFile)) { if (Date.now() > deadline) process.exit(3); sleep(2); }

const out: string[] = [];
if (mode === 'real') {
  const { makeOrchBypassRecorder, evaluateOrchestratorProfileHook } =
    await import('../../../src/server/runtime/claude-runtime.ts');
  const rec = makeOrchBypassRecorder({ sessionId, sessionLabel: sessionId });
  for (let i = 0; i < K; i++) {
    const o: any = evaluateOrchestratorProfileHook({ tool_name: 'Bash', tool_input: { command } }, rec);
    out.push(o?.hookSpecificOutput?.permissionDecision ?? 'none');
  }
} else {
  const { round3Record } = await import('./round3-recorder.mts');
  for (let i = 0; i < K; i++) {
    const okd = round3Record(dataDir, {
      at: new Date().toISOString(), event: 'orch-bypass', count: i + 1, sessionId, sessionLabel: sessionId,
      reason, command: command.slice(0, 500),
    });
    out.push(okd ? 'allow' : 'deny');
  }
}
(fs as any).writeSync = realWrite;
process.stdout.write(JSON.stringify({ sessionId, decisions: out }) + '\n');
