/**
 * ARCH-017 — stand-in for `scripts/dispatch.mjs` when exercising the BROKER's
 * lane-ledger writes without spending a real provider turn. Deliberately close
 * to the real child's contract: it writes `--meta-out` (including the `usage`
 * block the real script now carries), prints the result on stdout, and echoes
 * its own argv so a test can join the ledger record to the real process.
 */
import * as fs from 'node:fs';

const args = process.argv.slice(2);
const value = (f) => args[args.indexOf(f) + 1];
const prompt = fs.readFileSync(0, 'utf8');
if (prompt.includes('hang')) await new Promise((r) => setTimeout(r, 600_000));
const delay = Number((prompt.match(/delay=(\d+)/) || [])[1] || 0);
if (delay) await new Promise((r) => setTimeout(r, delay));
if (prompt.includes('slow')) await new Promise((r) => setTimeout(r, 1500));
if (prompt.includes('fail')) {
  fs.writeFileSync(value('--meta-out'), JSON.stringify({ provider: 'openai', sessionId: 'fixture-session', exitCode: 7, failureKind: 'internal', usage: null }));
  /* `withtext` — a FAILED lane that still produced output. The broker sends that
   * text as the terminal frame's payload and the consumer's channel for it is
   * stderr, so this is the case that distinguishes "a failure with something to
   * deliver" from the empty-result case ARCH-017 round 5 refuses to stamp. */
  if (prompt.includes('withtext')) process.stdout.write(`fixture failure payload `.padEnd(512, 'F'));
  process.stderr.write('dispatch failed [internal] fixture failure\n');
  process.exit(7);
}
const usage = { input_tokens: 1234, output_tokens: 567, cache_read_input_tokens: 89 };
fs.writeFileSync(value('--meta-out'), JSON.stringify({ provider: 'openai', model: value('--model') ?? null, sessionId: 'fixture-session', exitCode: 0, failureKind: null, usage }));
/* `size=N` — a deliberately LARGE result. The delivery receipt is a byte count,
 * and a multi-megabyte result is the case that broke the round-2 confirm window
 * (the peer needed longer to write it out than the window allowed). */
const size = Number((prompt.match(/size=(\d+)/) || [])[1] || 0);
/* `emptyresult` — a lane that succeeds and produces NO output. ARCH-017 round 5:
 * the digest over zero bytes is a constant, so this is the one input on which a
 * possession proof proves nothing. The broker must say so rather than stamp it. */
if (prompt.includes('emptyresult')) process.stdout.write('');
else if (size > 0) process.stdout.write(`big result lane size=${size} `.padEnd(size, 'X'));
else process.stdout.write(JSON.stringify({ args, cwd: process.cwd(), prompt }));
