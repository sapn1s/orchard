#!/usr/bin/env node
import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2); const opts = { provider: null, model: null, sandbox: null, timeoutMin: null, ticket: null, phase: null, round: null, class: null, stdin: false, check: false }; const prompt = [];
const take = (i, flag) => { if (i + 1 >= args.length) throw new Error(`${flag} needs a value`); return args[i + 1]; };
try { for (let i = 0; i < args.length; i++) { const a = args[i]; if (a === '--check') opts.check = true; else if (a === '--prompt-stdin') opts.stdin = true; else if (['--provider','--model','--sandbox','--timeout-min','--ticket','--phase','--round','--class'].includes(a)) { const key = a === '--timeout-min' ? 'timeoutMin' : a.slice(2); opts[key] = take(i, a); i++; } else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`); else prompt.push(a); } } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(2); }
const socketPath = process.env.ORCHARD_DISPATCH_SOCK;
const here = path.dirname(fileURLToPath(import.meta.url));
const checkoutScript = path.resolve(here, '..', '..', 'scripts', 'dispatch.mjs');

function direct(argv, body) { const c = spawn(process.execPath, [checkoutScript, ...argv], { stdio: ['pipe', 'inherit', 'inherit'] }); c.stdin.end(body); c.on('exit', (code) => process.exit(code ?? 1)); c.on('error', (e) => { process.stderr.write(`dispatch failed [transport] ${e.message}\n`); process.exit(1); }); }
/*
 * ARCH-017 — THE RECEIPT, AND IT CARRIES A NUMBER.
 *
 * The broker's lane ledger may only stamp a result "delivered" on evidence that
 * this process actually received AND emitted it. Three weaker signals were each
 * broken by an independent verifier; the third was this file's own bare
 * `{"op":"ack"}`, sent from a `catch` that swallowed the write failure:
 *   ATTACK A (/dev/full stdout, ENOSPC): 0 bytes reached the parent, delivered:true
 *   ATTACK B (reader hung up, EPIPE)   : 0 bytes reached the parent, delivered:true
 * — and a `delivered` record is prunable, so 70 dispatches later both the record
 * and the stored result were gone. A result that reached nobody, marked
 * delivered, then deleted, is precisely the failure this ticket exists to stop.
 *
 * ROUND 4 — AND A COUNT IS NOT ENOUGH EITHER. A cross-provider verifier pointed
 * out what four rounds had missed: a byte count is a NUMBER, and a peer can
 * produce a number without receiving anything. Reproduced end to end
 * (`scripts/scratch-a17-r4-forged-receipt.mjs`): one honest dispatch to learn the
 * length, then a peer that never attaches a data handler acks that number and is
 * stamped delivered — `peerBytesReceived=0 claimed=328 delivered=true`.
 *
 * So the receipt is now a PROOF OF POSSESSION, not a self-report: the result
 * frame carries a per-lane `receiptNonce`, and this process returns
 * `sha256(nonce ‖ the exact bytes it wrote to its own fd)`. It cannot be guessed,
 * it cannot be computed without holding the bytes, and truncated or altered
 * output produces a different digest. The count is still sent, but only as a
 * human-readable number in the audit trail — it is no longer the evidence.
 *
 * The two halves of the fact stay with their owners: the server knows what it
 * wrote to the socket (and records that separately as HANDOFF), this process
 * knows what it put on its fd, and neither asserts the other's.
 * Consequences that are the point, not side effects:
 *   - a write that THROWS (ENOSPC, EPIPE) sends NO ack and exits non-zero, so
 *     the record stays HELD and the result stays pullable;
 *   - a PARTIAL write reports the smaller number, which cannot match;
 *   - a peer that never read the frame cannot know the number at all.
 * `fs.writeSync` (not `process.stdout.write`) because it cannot be truncated by
 * `process.exit()` the way a buffered stream write can, and because it is the
 * only form whose return value is the count of bytes actually handed to the fd.
 */
function writeAllSync(fd, buf) {
  let off = 0;
  while (off < buf.length) {
    const n = fs.writeSync(fd, buf, off, buf.length - off);
    if (!(n > 0)) break; // a 0-byte write is not progress; stop rather than spin
    off += n;
  }
  return off;
}

function ackAndExit(s, f) {
  const code = f.ok ? 0 : (f.exitCode || 1);
  /*
   * ROUND 8 — THE RECEIPTED PAYLOAD IS THE BROKER'S OWN TEXT, `?? ''`, NOT `|| …`.
   *
   * The failure branch used `f.text || 'host broker failed'`, so an EMPTY failure
   * text was SUBSTITUTED with that string and then hashed — while the broker
   * hashes `frame.text ?? ''` (empty). A fourth cross-provider review measured the
   * disagreement:  `2 mismatch ok=false text=""`.  The two sides must hash the
   * SAME bytes; the human fallback is DECORATION written separately and not
   * counted, exactly like the `dispatch failed [...]` prefix. `?? ''` (nullish),
   * so a genuinely empty result stays empty and the digest matches the broker's.
   */
  const payload = Buffer.from(f.text ?? '', 'utf8');
  const expected = payload.length;
  const fd = f.ok ? 1 : 2;
  let wrote = 0;
  let writeError = null;
  try {
    if (f.ok) {
      wrote = writeAllSync(1, payload);
    } else {
      // The decoration is OURS; only the broker's own text is the payload being
      // receipted, so the prefix/suffix (and the empty-text fallback) are written
      // separately and NOT counted toward `wrote`/the digest.
      writeAllSync(2, Buffer.from(`dispatch failed [${f.failureKind || 'internal'}] `, 'utf8'));
      wrote = writeAllSync(2, payload);
      if (payload.length === 0) writeAllSync(2, Buffer.from('host broker failed', 'utf8'));
      writeAllSync(2, Buffer.from('\n', 'utf8'));
    }
  } catch (e) { writeError = e; }
  let done = false;
  const finish = (exitCode) => { if (done) return; done = true; try { s.end(); } catch { /* already closed */ } process.exit(exitCode); };
  if (writeError || wrote !== expected) {
    /* NO ACK. The broker must hold a result this process could not emit — and
     * the caller must not be told the lane succeeded. */
    try { fs.writeSync(2, `dispatch failed [output-write-failed] wrote ${wrote} of ${expected} bytes to fd ${fd}${writeError ? `: ${writeError.message}` : ''}; the result is HELD by the broker, not lost\n`); } catch { /* stderr is gone too */ }
    return finish(code === 0 ? 1 : code);
  }
  /* The proof of possession, over the bytes this process actually wrote. An
   * older broker sends no nonce; then only the (forgeable) count goes back, that
   * broker's own rule applies, and nothing here pretends otherwise. */
  /* ROUND 5 — the digest is bound to the DESTINATION, not just to the bytes.
   * A cross-provider verifier showed that round 4's `sha256(nonce ‖ bytes)`
   * receipt for a payload written only to fd 2 is byte-for-byte identical to
   * the receipt for an fd-1 write: the channel was simply not part of the
   * statement. It is now, so a receipt says WHICH fd these bytes went to and a
   * peer that writes a result to the wrong channel cannot produce a matching
   * one. This remains the CONSUMER's own statement — no process can inspect
   * another's file descriptors — so it is specificity, not proof of emission,
   * and the broker's evidence string says exactly that. */
  const receipt = { op: 'ack', bytes: wrote, fd };
  if (typeof f.receiptNonce === 'string' && f.receiptNonce) {
    /* ROUND 7 — LENGTH-DELIMITED CHANNEL, matching `lanes.receiptDigest`.
     * The broker verifies with `lanes.receiptDigest(nonce, `fd${fd}`, bytes)`,
     * which round 7 changed to hash `nonce ‖ len(channel)":" ‖ channel ‖ bytes`
     * (channel `"a"`/bytes `"bc"` and channel `"ab"`/bytes `"c"` collided under
     * the old bare concatenation once channels became free-form). This is the
     * REAL socket peer — it was NOT updated with the shared rule, so every
     * genuine receipt hashed the old way and the broker refused live delivery
     * (ledger legs C1/C4 through the real client, and D15-D17, all failed).
     * The channel here is `fd${fd}`; it must be delimited identically. */
    const chBuf = Buffer.from(`fd${fd}`, 'utf8');
    receipt.digest = crypto.createHash('sha256').update(f.receiptNonce).update(`${chBuf.length}:`).update(chBuf).update(payload.subarray(0, wrote)).digest('hex');
  }
  try { s.write(`${JSON.stringify(receipt)}\n`, () => finish(code)); } catch { return finish(code); }
  setTimeout(() => finish(code), 2000).unref?.();
}
function unavailable(reason, action = 'enable settings.tools.openaiDispatch for this project and launch a new session') { process.stdout.write(`openai dispatch: unavailable\nroute: none\nreason: ${reason}\naction: ${action}\n`); process.exit(1); }
function socketRequest(req, check) { const s = net.createConnection(socketPath); let buf = ''; let terminal = false; s.setEncoding('utf8'); s.on('connect', () => s.write(`${JSON.stringify(req)}\n`)); s.on('data', (chunk) => { buf += chunk; for (;;) { const n = buf.indexOf('\n'); if (n < 0) break; const line = buf.slice(0,n); buf = buf.slice(n+1); let f; try { f=JSON.parse(line); } catch { continue; } if (check) { process.stdout.write(`openai dispatch: ${f.ok && f.entitled ? 'available' : 'unavailable'}\nroute: host broker unix socket ${socketPath}\nproviders: ${(f.providers||[]).join(',') || 'none'}\nmodels: ${JSON.stringify(f.models||{})}\ncommand: ${f.dispatchCmd || process.env.ORCHARD_DISPATCH_CMD || 'node /opt/orchard-dispatch/dispatch-client.mjs'}\n`); terminal=true; s.end(); process.exit(f.ok && f.entitled ? 0 : 1); } if (f.op === 'progress') process.stderr.write(f.text); if (f.op === 'result') { terminal=true; ackAndExit(s, f); return; } } }); s.on('error', (e) => check ? unavailable(`broker socket cannot be reached: ${e.message}`) : (process.stderr.write(`dispatch failed [transport] ${e.message}\n`), process.exit(1))); s.on('close', () => { if (!terminal) { process.stderr.write('dispatch failed [transport] broker closed without a terminal frame\n'); process.exit(1); } }); }

if (opts.check) { if (process.env.ORCHARD_DISPATCH_ENTITLED === '0') unavailable('this session was launched with settings.tools.openaiDispatch disabled'); else if (process.env.ORCHARD_DISPATCH_UNAVAILABLE_REASON) unavailable(process.env.ORCHARD_DISPATCH_UNAVAILABLE_REASON, 'fix the reported host broker failure and launch a new session'); else if (socketPath) socketRequest({ op:'capabilities' }, true); else if (fs.existsSync(checkoutScript)) { process.stdout.write(`openai dispatch: available\nroute: direct host checkout\nproviders: openai\nmodels: provider default or --model\ncommand: node ${fileURLToPath(import.meta.url)}\n`); process.exit(0); } else unavailable('no broker socket and the Orchard checkout is not readable'); }
else { let body = prompt.join(' ').trim(); if (opts.stdin) { if (body) { process.stderr.write('dispatch failed [invalid-request] --prompt-stdin and positional prompt are mutually exclusive\n'); process.exit(2); } body=fs.readFileSync(0,'utf8'); } if (!body.trim()) { process.stderr.write('dispatch failed [invalid-request] no prompt given\n'); process.exit(2); } if (!opts.provider) opts.provider='openai'; if (socketPath) socketRequest({ op:'dispatch', ack:true, provider:opts.provider, ...(opts.model?{model:opts.model}:{}), ...(opts.sandbox?{sandbox:opts.sandbox}:{}), ...(opts.timeoutMin?{timeoutMin:Number(opts.timeoutMin)}:{}), ...(opts.ticket?{ticket:opts.ticket}:{}), ...(opts.phase?{phase:opts.phase}:{}), ...(opts.round?{round:opts.round}:{}), ...(opts.class?{class:opts.class}:{}), prompt:body }, false); else if (fs.existsSync(checkoutScript)) { const av=['--provider',opts.provider,'--prompt-stdin']; for (const [k,f] of [['model','--model'],['sandbox','--sandbox'],['timeoutMin','--timeout-min'],['ticket','--ticket'],['phase','--phase'],['round','--round'],['class','--class']]) if(opts[k]) av.push(f,String(opts[k])); direct(av,body); } else unavailable('no broker socket and the Orchard checkout is not readable'); }
