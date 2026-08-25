#!/usr/bin/env node
/**
 * BUG-078 — UTF-8 decode across stream-chunk boundaries.
 *
 *   node scripts/verify-bug-078-multibyte.mjs
 *
 * Two stdout readers used to decode each raw Buffer chunk independently
 * (`buf += d.toString()` in codex-runtime.ts, `stdoutBuf += d` in
 * dispatch.mjs). Node emits `data` as Buffers split at arbitrary byte
 * offsets, so any multibyte codepoint whose bytes straddle two chunks
 * decoded to U+FFFD replacement chars in each half — silent content
 * corruption inside JSON string values (structural bytes are ASCII, so the
 * parse still succeeds). The fix is `stream.setEncoding('utf8')` (Node's
 * StringDecoder buffers partial codepoints) at every accumulator in both
 * files.
 *
 * This suite exercises the REAL code at BOTH sites with a multibyte string
 * chunked at the byte that splits a codepoint:
 *   A  codex frame path — a fake app-server child (injected through the
 *      runtime's own spawnProcess seam) emits an `item/completed`
 *      agentMessage frame whose bytes are pushed as TWO chunks split inside
 *      a 4-byte emoji; the assistant text off rt.messages() must be
 *      byte-identical.
 *   B  dispatch anthropic result path — a fake `claude` shim on PATH writes
 *      the `--output-format json` result blob in two timed writes split
 *      inside the same emoji; dispatch.mjs's stdout (the unwrapped `result`)
 *      must be byte-identical.
 *
 * MUST FAIL pre-fix: both checks observe a U+FFFD pair where the emoji was.
 * Kill by pid only; scratch temp dirs; nothing global touched.
 */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DISPATCH = path.join(ROOT, 'scripts', 'dispatch.mjs');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? JSON.stringify(observed) : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}

// A payload with a 4-byte codepoint (U+1F389 🎉, bytes F0 9F 8E 89) padded so
// the split lands mid-message, not at a frame/JSON boundary.
const EMOJI = '🎉';
const PAYLOAD = `alpha ${'x'.repeat(80)} ${EMOJI} café ${'y'.repeat(80)} omega`;

/** Split a UTF-8 buffer at a byte INSIDE the emoji's 4-byte sequence. */
function splitInsideEmoji(buf) {
  const idx = buf.indexOf(Buffer.from(EMOJI, 'utf8'));
  if (idx < 0) throw new Error('emoji not found in buffer');
  const at = idx + 2; // between byte 2 and 3 of the 4-byte codepoint
  return [buf.subarray(0, at), buf.subarray(at)];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------ A: codex frame path */

/**
 * A minimal fake `codex app-server` living entirely in this process, injected
 * through CodexRuntime's spawnProcess seam. Its stdout is a real PassThrough
 * (so setEncoding('utf8') behaves exactly as it does for a real pipe), and the
 * agentMessage frame is pushed as two Buffers split inside the emoji.
 */
function makeFakeCodexChild() {
  const child = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  child.stdout = stdout;
  child.stderr = stderr;
  child.pid = -1;
  child.kill = () => {};

  const send = (obj) => stdout.write(Buffer.from(JSON.stringify(obj) + '\n', 'utf8'));

  const emitSplitMessage = async () => {
    const frame = {
      jsonrpc: '2.0',
      method: 'item/completed',
      params: { threadId: 't1', turnId: 'turn1', item: { id: 'm1', type: 'agentMessage', text: PAYLOAD } },
    };
    const [a, b] = splitInsideEmoji(Buffer.from(JSON.stringify(frame) + '\n', 'utf8'));
    stdout.write(a);
    await sleep(15);           // force TWO separate 'data' events, codepoint straddling them
    stdout.write(b);
    await sleep(5);
    send({ jsonrpc: '2.0', method: 'thread/tokenUsage/updated', params: { threadId: 't1', turnId: 'turn1', tokenUsage: { last: { totalTokens: 3 } } } });
    send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 't1', turn: { id: 'turn1', status: 'completed', items: [] } } });
  };

  let inbuf = '';
  child.stdin = new Writable({
    write(chunk, _enc, cb) {
      inbuf += chunk.toString();
      let nl;
      while ((nl = inbuf.indexOf('\n')) >= 0) {
        const line = inbuf.slice(0, nl).trim();
        inbuf = inbuf.slice(nl + 1);
        if (!line) continue;
        let f; try { f = JSON.parse(line); } catch { continue; }
        if (f.method === 'initialize') send({ jsonrpc: '2.0', id: f.id, result: { protocolVersion: '1', capabilities: {} } });
        else if (f.method === 'thread/start') send({ jsonrpc: '2.0', id: f.id, result: { thread: { id: 't1' } } });
        else if (f.method === 'turn/start') { send({ jsonrpc: '2.0', id: f.id, result: { turn: { id: 'turn1' } } }); void emitSplitMessage(); }
        // 'initialized' is a notification (no id) — nothing to answer.
      }
      cb();
    },
    final(cb) { cb(); },
  });
  return child;
}

async function testCodexFramePath() {
  const mod = await import('../src/server/runtime/codex-runtime.ts');
  const { CodexRuntime } = mod;
  const rt = new CodexRuntime();
  let assistantText = null;

  rt.start({
    cwd: ROOT,
    firstPrompt: 'hi',
    permissionMode: 'dispatch:read-only',
    onApproval: async () => ({ behavior: 'deny', message: 'n/a' }),
    spawnProcess: () => makeFakeCodexChild(),
  });

  const deadline = Date.now() + 6000;
  for await (const m of rt.messages()) {
    if (m.type === 'assistant') {
      const block = m.message?.content?.[0];
      if (block?.type === 'text') { assistantText = block.text; }
    }
    if (m.type === 'result') break;
    if (Date.now() > deadline) break;
  }
  rt.close();

  const clean = assistantText != null && !assistantText.includes('�');
  check('codex frame path: no U+FFFD in decoded agentMessage', clean, assistantText);
  check('codex frame path: assistant text byte-identical across chunk split', assistantText === PAYLOAD, assistantText);
}

/* ------------------------------------ B: dispatch anthropic result path */

async function testDispatchAnthropicPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug078-'));
  const shim = path.join(dir, 'claude');
  // A fake `claude`: writes the --output-format json blob in two timed writes,
  // split inside the emoji, so dispatch.mjs's stdout accumulator sees the
  // codepoint straddling two 'data' events.
  const shimSrc = `#!/usr/bin/env node
const EMOJI = ${JSON.stringify(EMOJI)};
const result = ${JSON.stringify(PAYLOAD)};
const json = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, session_id: 's1', usage: {} });
const buf = Buffer.from(json, 'utf8');
const idx = buf.indexOf(Buffer.from(EMOJI, 'utf8'));
const at = idx + 2;
process.stdout.write(buf.subarray(0, at));
setTimeout(() => { process.stdout.write(buf.subarray(at)); process.stdout.end(); }, 40);
`;
  fs.writeFileSync(shim, shimSrc, { mode: 0o755 });

  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [DISPATCH, '--provider', 'anthropic', '--cwd', dir, 'do a thing'], {
      cwd: ROOT,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const guard = setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 30_000);
    child.once('exit', (code) => { clearTimeout(guard); resolve({ code, stdout, stderr }); });
  });

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }

  const out = result.stdout.replace(/\n$/, '');
  const clean = !out.includes('�');
  check('dispatch anthropic path: exit 0', result.code === 0, `code ${result.code} / stderr ${result.stderr.slice(-160)}`);
  check('dispatch anthropic path: no U+FFFD in result text', clean, out);
  check('dispatch anthropic path: result byte-identical across chunk split', out === PAYLOAD, out);
}

/* --------------------------------------------------------------- run */

await testCodexFramePath();
await testDispatchAnthropicPath();

console.log(`\nBUG-078 multibyte: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILURES:', failures.join(', ')); process.exit(1); }
console.log('ALL GREEN');
