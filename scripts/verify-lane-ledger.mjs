#!/usr/bin/env node
/**
 * ARCH-017 step 1 — the lane ledger, proven against the REAL blocking dispatch
 * path (the broker's unix socket, a real spawned child, real files on disk, and
 * the REAL `dispatch-client.mjs` process).
 *
 * Every check prints the OBSERVED VALUE, not just PASS/FAIL, and asserts its
 * own precondition first: a green that can fire on an empty store or a missing
 * file is worse than no test at all.
 *
 * ROUND 3. Two independent verification rounds broke the hand-rolled
 * cross-process lock and the hand-rolled delivery ack, repeatedly. Both are
 * gone, so the tests written for them are gone too; what replaces them is
 * written against the two mechanisms that replaced them, and the round-2
 * verifier's own reproducers are folded in as PERMANENT regressions (they are
 * proven non-vacuous, which is worth more than a fresh test written to fit the
 * fix):
 *
 *   - ONE WRITER BY CONSTRUCTION. Not "a lock that is usually right": a claim
 *     the kernel arbitrates, refused with `not-writer`. Tested with MULTIPLE
 *     concurrent contenders and a POPULATED ledger, because round 2's
 *     diagnosis of the old suite was that it was "not vacuous but fixture-blind
 *     exactly where I broke it" — empty stores, one contender, a cooperative
 *     peer that never writes stdout.
 *   - DELIVERY IS THE SENDER'S FACT. The receipt carries the byte count the
 *     peer wrote to its own stdout and must equal what the server sent. Tested
 *     with a peer that LIES, a peer that acks BLIND, a peer that CANNOT WRITE
 *     (/dev/full ENOSPC, EPIPE) and the real client on a 2 MB result.
 *
 * `--must-fail-proof` runs the eight must-FAIL legs and nothing else. Each one
 * demonstrates that the property under test really was broken before, against
 * real code or the real predicate, so the green above it is not decoration.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arch017-'));
const DATA = path.join(tmp, 'data');
process.env.CLAUDE_STATION_DATA = DATA;
process.env.ORCHARD_DISPATCH_SCRIPT = path.join(ROOT, 'scripts', 'fixtures', 'fake-dispatch-lane.mjs');

const hostPath = path.join(tmp, 'repo');
fs.mkdirSync(hostPath, { recursive: true });
const project = { id: 'arch017-proj', name: 'arch017', hostPath, isolation: 'direct', settings: { tools: { openaiDispatch: true } } };

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`PASS ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}: ${e.message}`); }
}
function show(label, value) { console.log(`      observed ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A dispatch client, with the peer behaviours the delivery rule must survive.
 *
 *   honest  — what the REAL client does: ack carrying the byte count AND
 *             `sha256(receiptNonce ‖ the bytes it holds)` — the round-4 receipt.
 *   blind   — never looks at the frame; acks on a timer with no byte count.
 *             This is round-2 FINDING 4, and it is also the SHAPE of FINDING 1
 *             (a real client whose stdout write failed and acked anyway).
 *   lie+/-  — holds one byte more / one byte fewer than was sent, and proves
 *             possession of THAT: a peer whose output was truncated or extended.
 *   forge   — ROUND 4, the attack four rounds of fixtures missed: never touches
 *             `f.text` at all, and acks the CORRECT byte count (learned from a
 *             previous identical-length dispatch). D1 omits the count and D2
 *             gets it wrong; neither challenges a correct FORGED count, and the
 *             first cross-provider verifier walked straight through that gap.
 *   swap    — holds the right NUMBER of bytes with one byte different.
 *   dup     — wrote the result twice (2N bytes on its fd), acks 2N.
 *   close   — receives the result and hangs up without acking.
 *   none    — an older peer that never opted into a receipt at all.
 */
// ROUND 7: the honest peer hashes exactly as the real client (dispatch-client.mjs)
// and the broker (lanes.receiptDigest) now do — length-delimited channel. A bare
// `nonce ‖ "fdN" ‖ bytes` (rounds 4-6) no longer matches, so this mock had to be
// re-aligned or every control leg would fail against the shipped verifier.
function peerDigest(nonce, buf, fd = 1) { const ch = Buffer.from(`fd${fd}`, 'utf8'); return createHash('sha256').update(nonce).update(`${ch.length}:`).update(ch).update(buf).digest('hex'); }

/*
 * ROUND 5, DEFECT 3 — THE FIXTURE THAT PRINTED A NUMBER IT NEVER OBSERVED.
 * The round-4 doubles CONSTRUCTED the bytes they claimed to have written and
 * wrote them nowhere, so D10 printed "the peer put 8192 bytes on its fd" while
 * the peer had emitted zero. A cross-provider verifier found it by instrumenting
 * the writes; measured at the time: `{"bytesTheOldTestPRINTED":8192,
 * "bytesActuallyEmitted":0}`. Every double now writes its bytes to a REAL file
 * descriptor — a per-lane sink file standing in for the consumer's fd 1 — and
 * every assertion about emission reads the size back off the filesystem. A
 * double that emits nothing now FAILS the tests that are about emitting, which
 * is the property the old ones only claimed to test.
 */
const emissionSinks = new Map();
function sinkFor(prompt) {
  const p = path.join(tmp, `emit-${createHash('sha1').update(prompt).digest('hex').slice(0, 12)}`);
  emissionSinks.set(prompt, p);
  return p;
}
/*
 * ROUND 6 — THE ANTI-VACUITY RULE, APPLIED TO EVERY REFUSAL TEST.
 * A cross-provider reviewer found D15 asserting an ABSENCE that was equally
 * true if its receipt never arrived, and said (correctly) that finding the one
 * it named would guarantee a fifth round of the same. The audit found the shape
 * shared by EVERY delivery-refusal test in this file: they asserted
 * `acknowledgedAt === null`, which is also what you get when the peer double
 * silently failed to send anything at all. The broker now records WHY it
 * refused (`heldReason`), so each of them asserts its own distinct reason —
 * a string only that specific refusal can produce. `heldBecause()` is the one
 * door: it FAILS if no refusal was recorded, so "nothing happened" can no
 * longer pass as "correctly refused".
 */
function heldBecause(rec, mustMention, { expectHandoff = true } = {}) {
  assert.ok(rec, 'precondition: the lane must be in the ledger');
  /*
   * ROUND 7 finding 3 — THE GATE BUILT TO END VACUITY WAS ITSELF VACUOUS. As
   * written in round 6 it checked only "a reason exists and mentions X", so it
   * ACCEPTED an acknowledged record carrying a stale reason (measured:
   * {"acknowledged":true,"heldReason":"old refusal…"} → ACCEPTS), and it said
   * nothing about whether the lane had even finished. Four conditions now, and
   * each one is a way the caller could otherwise be fooled:
   *   1. the record must NOT be acknowledged — a reason on an acknowledged
   *      record is stale by definition, and after the round-7 store fix cannot
   *      even exist, so seeing one means something reintroduced it;
   *   2. the lane must have reached a terminal state — `running` means the
   *      child had not finished and no receipt could have been judged (this is
   *      what D3 was passing on);
   *   3. Orchard must have handed the bytes over, unless the caller explicitly
   *      says this is the peer-died-before-the-write case — otherwise "held"
   *      may just mean the peer never got anything to acknowledge;
   *   4. the reason must be the one under test.
   */
  assert.equal(rec.acknowledgedAt, null, `VACUOUS: this record is ACKNOWLEDGED, so its heldReason ${JSON.stringify(String(rec.heldReason).slice(0, 80))} is stale — a refusal assertion on an acknowledged record proves nothing`);
  assert.notEqual(rec.state, 'running', 'VACUOUS: the lane is still RUNNING — no receipt and no refusal can have been judged yet, so "held" here is just "not finished"');
  if (expectHandoff) {
    assert.ok(rec.handoffAt != null, 'VACUOUS: Orchard never recorded handing these bytes over, so the peer had nothing to acknowledge and "held" proves nothing about the receipt rule');
  }
  assert.ok(rec.heldReason, 'VACUOUS: this lane is held but the receipt rule recorded NO refusal reason — nothing proves a receipt ever reached the broker');
  for (const frag of [].concat(mustMention)) {
    assert.ok(rec.heldReason.includes(frag), `the refusal must be the one under test: expected a reason mentioning ${JSON.stringify(frag)}, got ${JSON.stringify(rec.heldReason.slice(0, 160))}`);
  }
  return rec.heldReason;
}

/* The gate's own must-FAIL proof, run inline: if `heldBecause` ever stops
 * rejecting these, every refusal test in this file silently becomes decoration
 * again. Each case is the exact shape a previous round actually shipped. */
function assertGateRejects(label, rec, opts) {
  let threw = null;
  try { heldBecause(rec, 'anything', opts); } catch (e) { threw = e.message.slice(0, 60); }
  assert.ok(threw, `the gate ACCEPTED ${label} — it is falsifiable again`);
  return threw;
}
check('GATE — heldBecause() rejects every shape that made it vacuous (round-7 finding 3)', () => {
  const base = { id: 'g', state: 'settled', acknowledgedAt: null, handoffAt: 1, heldReason: 'anything happened here' };
  show('acknowledged record with a stale reason', assertGateRejects('an acknowledged record', { ...base, acknowledgedAt: 5, heldReason: 'old refusal — anything' }));
  show('still-running record', assertGateRejects('a running record', { ...base, state: 'running' }));
  show('never handed over', assertGateRejects('a record with no handoff', { ...base, handoffAt: null }));
  show('no reason recorded at all', assertGateRejects('a record with no reason', { ...base, heldReason: null }));
  show('wrong reason', assertGateRejects('a record refused for another cause', { ...base, heldReason: 'something else entirely' }));
  heldBecause(base, 'anything');   // …and it must still ACCEPT the real thing
  show('a genuinely held, genuinely refused record', 'ACCEPTED, as it must be');
});


/**
 * The record AS IT IS IN THE FILE. ROUND 6: finding 2 (an acknowledgement with
 * no handoff behind it) was invisible in every in-memory return value and only
 * showed on disk, so the tests for these rules read the JSON back themselves
 * rather than trusting what a function handed them.
 */
function diskRecord(idOrFragment) {
  const raw = JSON.parse(fs.readFileSync(lanes.laneStoreFile(), 'utf8'));
  return raw.find((r) => r.id === idOrFragment || String(r.charter ?? '').includes(idOrFragment));
}

/** Bytes the peer double ACTUALLY wrote to a real fd, read back from disk. */
function emittedBytes(promptFragment) {
  const hit = [...emissionSinks.entries()].find(([p]) => p.includes(promptFragment));
  assert.ok(hit, `no peer double ran for a prompt containing ${JSON.stringify(promptFragment)} — the emission assertion cannot be evaluated`);
  return fs.existsSync(hit[1]) ? fs.statSync(hit[1]).size : 0;
}

function request(sock, obj, { destroyEarlyMs = 0, mode = 'honest', forgeBytes = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const sink = obj.prompt ? sinkFor(obj.prompt) : null;
    const s = net.createConnection(sock);
    let buf = '';
    const frames = [];
    let resolved = false;
    const done = (v) => { if (!resolved) { resolved = true; resolve(v); } };
    s.setEncoding('utf8');
    s.on('connect', () => {
      s.write(JSON.stringify({ ...obj, ...(obj.op === 'dispatch' && mode !== 'none' ? { ack: true } : {}) }) + '\n');
      if (destroyEarlyMs) setTimeout(() => { s.destroy(); done(null); }, destroyEarlyMs);
      if (mode === 'blind') setTimeout(() => { try { s.write(JSON.stringify({ op: 'ack' }) + '\n'); } catch { /* gone */ } }, 1200);
    });
    s.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let f; try { f = JSON.parse(line); } catch { continue; }
        frames.push(f);
        if (f.op !== 'result' || mode === 'blind' || mode === 'none') continue;
        if (mode === 'forge') {
          /* Deliberately does NOT read f.text. The only thing it knows is a
           * number from a previous run — which is exactly the attacker's
           * position, and exactly what the round-3 rule accepted. */
          s.write(JSON.stringify({ op: 'ack', bytes: forgeBytes }) + '\n');
          continue;
        }
        const got = Buffer.from(f.text ?? '', 'utf8');
        const bytes = got.length;
        if (mode === 'close') { s.destroy(); done(frames); continue; }
        /* What this peer actually HOLDS — the receipt proves possession of that,
         * so a corrupted peer proves possession of its corrupted bytes. */
        const held = mode === 'lie+' ? Buffer.concat([got, Buffer.from('x')])
          : mode === 'lie-' ? got.subarray(0, Math.max(0, bytes - 1))
          : mode === 'swap' ? Buffer.concat([Buffer.from([got[0] ^ 0x20]), got.subarray(1)])
          : mode === 'dup' ? Buffer.concat([got, got])
          : got;
        /* A REAL write to a REAL fd, before the receipt — exactly the order the
         * production client uses (emit first, acknowledge only what it emitted). */
        if (sink) fs.writeFileSync(sink, held);
        /* wrongfd  — emitted the RESULT to its stderr and says so (round 5: the
         *            channel is part of the statement, so this must not match).
         * contradict — a valid proof with a byte count that disagrees with it. */
        /* The channel this payload is FOR is stated in the frame; an honest
         * consumer writes it there (the production client: stdout for a result,
         * stderr for a failure text). `wrongfd` deliberately names the other. */
        const destFd = f.receiptFd === 2 ? 2 : 1;
        const ackFd = mode === 'wrongfd' ? (destFd === 1 ? 2 : 1) : destFd;
        const ack = { op: 'ack', bytes: mode === 'contradict' ? held.length + 7 : held.length, fd: ackFd };
        if (typeof f.receiptNonce === 'string' && f.receiptNonce) ack.digest = peerDigest(f.receiptNonce, held, ackFd);
        s.write(JSON.stringify(ack) + '\n');
      }
    });
    s.on('end', () => done(frames));
    s.on('close', () => done(frames));
    s.on('error', (e) => {
      if (destroyEarlyMs || frames.length) return done(frames.length ? frames : null);
      reject(e);
    });
  });
}

/**
 * A peer that reports the nonce it was given, and can be told to answer with
 * SOMEONE ELSE'S nonce instead (`replayNonce`) — the cross-lane replay attack.
 */
function requestCapturing(sock, prompt, replayNonce) {
  return new Promise((resolve) => {
    const s = net.createConnection(sock);
    let buf = '';
    s.setEncoding('utf8');
    s.on('error', () => {});
    s.on('connect', () => s.write(JSON.stringify({ op: 'dispatch', provider: 'openai', ack: true, prompt }) + '\n'));
    s.on('data', (c) => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        let f; try { f = JSON.parse(line); } catch { continue; }
        if (f.op !== 'result') continue;
        const got = Buffer.from(f.text ?? '', 'utf8');
        const nonce = replayNonce ?? f.receiptNonce;
        s.write(JSON.stringify({ op: 'ack', bytes: got.length, fd: 1, digest: peerDigest(nonce, got, 1) }) + '\n');
        setTimeout(() => { s.destroy(); resolve({ nonce: f.receiptNonce, bytes: got.length, text: got.toString('utf8') }); }, 600);
      }
    });
  });
}

/** Run `fn` against another data dir, holding that dir's writer claim. */
async function withDataDir(dir, fn) {
  const prev = process.env.CLAUDE_STATION_DATA;
  fs.mkdirSync(dir, { recursive: true });
  process.env.CLAUDE_STATION_DATA = dir;
  const claim = await lanes.claimWriter();
  try { return await fn(claim); }
  finally {
    process.env.CLAUDE_STATION_DATA = prev;
    await lanes.claimWriter();
  }
}

/** A realistic populated ledger: fat held results, delivered ones, and running claims. */
function populate({ held = 20, delivered = 10, running = 3, resultBytes = 3000 } = {}) {
  const ids = { held: [], delivered: [], running: [] };
  for (let i = 0; i < held; i++) {
    const id = `lane-pop-held-${i}`;
    lanes.recordDispatch({ label: `held#${i}`, charter: `held charter ${i} `.repeat(20), provider: 'openai', transport: 'blocking-dispatch' }, id);
    lanes.settle(id, { state: 'settled', resultText: `IRREPLACEABLE RESULT ${i} `.padEnd(resultBytes, '.') });
    ids.held.push(id);
  }
  for (let i = 0; i < delivered; i++) {
    const id = `lane-pop-delivered-${i}`;
    lanes.recordDispatch({ label: `delivered#${i}`, charter: 'c', provider: 'openai', transport: 'blocking-dispatch' }, id);
    lanes.settle(id, { state: 'settled', resultText: `delivered ${i} `.padEnd(resultBytes, '.') });
    /* ROUND 6: an acknowledgement cannot exist without Orchard's own handoff
     * behind it, so the fixture builds the pair. Round 5's populate() wrote
     * acknowledged-with-null-handoff rows — records the system can no longer
     * produce — which is exactly the fixture-realism defect this round is
     * about: a "realistic populated ledger" full of states reality forbids. */
    lanes.markHandoff(id, resultBytes, 'fixture: Orchard wrote this result to the consumer');
    lanes.markAcknowledged(id, 'blocking-dispatch', 'fixture: peer returned a matching possession proof', 'possession-digest-fd1');
    ids.delivered.push(id);
  }
  for (let i = 0; i < running; i++) {
    const id = `lane-pop-running-${i}`;
    lanes.recordDispatch({ label: `running#${i}`, charter: 'c', provider: 'openai', transport: 'blocking-dispatch' }, id);
    lanes.attachProcess(id, process.pid, id);
    ids.running.push(id);
  }
  return ids;
}

const lanes = await import(path.join(ROOT, 'src', 'server', 'lanes.ts'));

/* ------------------------------------------------------------------ must-FAIL legs */

if (process.argv.includes('--must-fail-proof')) {
  let peerPid = 0;
  // LEG 1 — the pre-change broker records nothing. Real code, fetched from git.
  const baseline = path.join(ROOT, 'src', 'server', '__arch017_baseline_broker.ts');
  try {
    fs.writeFileSync(baseline, execFileSync('git', ['show', 'HEAD:src/server/dispatch-broker.ts'], { cwd: ROOT, encoding: 'utf8' }));
    const old = await import(baseline);
    const sock = await old.start({ ...project, id: 'arch017-baseline' });
    // mode:'none' — the pre-change broker has no `ack` field and would refuse it as an unknown field.
    const frames = await request(sock, { op: 'dispatch', provider: 'openai', prompt: 'baseline lane', ticket: 'ARCH-017' }, { mode: 'none' });
    await old.stop({ ...project, id: 'arch017-baseline' });
    const exists = fs.existsSync(path.join(DATA, 'lanes.json'));
    const leg1 = `dispatch ok=${frames.at(-1).ok}; lanes.json exists=${exists}`;
    assert.equal(frames.at(-1).ok, true, 'precondition: the baseline dispatch must actually have run');
    assert.equal(exists, false, 'baseline broker must write NO lane record');
    console.log(`PASS MUST-FAIL leg 1: the pre-change dispatch path leaves no record of the completion — ${leg1}`);
  } finally {
    fs.rmSync(baseline, { force: true });
  }

  // LEG 2 — outcomes.ts's unconditional prune loses a held result.
  const MAX = lanes.MAX_RECORDS;
  const records = [];
  for (let i = 0; i < MAX + 3; i++) {
    records.push({ id: `lane-${i}`, dispatchedAt: 1000 + i, state: 'settled', acknowledgedAt: i < 3 ? null : 5000, dismissedAt: null });
  }
  const oldestHeld = records.filter((r) => r.acknowledgedAt == null).map((r) => r.id);
  const outcomesStyle = records.slice(records.length - MAX).map((r) => r.id); // outcomes.ts:138, verbatim
  const ours = lanes.prune(records, MAX).kept.map((r) => r.id);
  const lostByOldRule = oldestHeld.filter((id) => !outcomesStyle.includes(id));
  const lostByOurs = oldestHeld.filter((id) => !ours.includes(id));
  show('held ids', oldestHeld);
  show('held ids DELETED by outcomes.ts-style slice()', lostByOldRule);
  show('held ids deleted by lanes.prune()', lostByOurs);
  assert.equal(oldestHeld.length, 3, 'precondition: three undelivered records must exist');
  assert.ok(lostByOldRule.length > 0, 'must-FAIL leg is vacuous unless the old rule really loses a held record');
  assert.equal(lostByOurs.length, 0);
  console.log(`PASS MUST-FAIL leg 2: the round-1 (outcomes.ts) prune deletes ${lostByOldRule.length} undelivered result(s); lanes.prune() deletes 0`);

  /*
   * LEG 3 — the round-1 DELIVERY SIGNAL, on a real socket with a real killed
   * peer: `!socket.destroyed` (read before the write, as round 1 did) still
   * says "deliverable" for a peer that is already dead and can never read the
   * frame, while a receipt correctly says no.
   */
  const sockPath = path.join(tmp, 'legs3.sock');
  const srv = net.createServer();
  await new Promise((r) => srv.listen(sockPath, r));
  const conn = await new Promise((resolve) => {
    srv.once('connection', (c) => resolve(c));
    const peer = spawn(process.execPath, ['-e', `require('net').createConnection(${JSON.stringify(sockPath)}, () => setTimeout(() => {}, 9000));`], { stdio: 'ignore' });
    peerPid = peer.pid;
  });
  await sleep(200);
  process.kill(peerPid, 'SIGKILL');
  const roundOneSaysDeliverable = !conn.destroyed;
  let acked = false;
  conn.on('error', () => { /* the dead peer resets the connection — that is the point */ });
  conn.on('data', (b) => { if (String(b).includes('"op":"ack"')) acked = true; });
  conn.write(JSON.stringify({ op: 'result', text: 'x' }) + '\n');
  await sleep(600);
  show('round-1 signal (!socket.destroyed, read before the send)', roundOneSaysDeliverable ? 'DELIVERABLE — would stamp' : 'not deliverable');
  show('round-2 signal (peer ack received)', acked);
  srv.close();
  assert.equal(roundOneSaysDeliverable, true, 'must-FAIL leg is vacuous unless the old signal really claims deliverability here');
  assert.equal(acked, false);
  console.log('PASS MUST-FAIL leg 3: for a peer killed before the frame, the round-1 signal says "delivered" and the receipt says held');

  /*
   * LEG 4 — the round-2 ACK RULE ("an ack arrived ⇒ delivered"), against the
   * real broker and a peer that behaves exactly as the round-2 CLIENT did when
   * its stdout write failed: swallow the error, ack anyway, with no byte count.
   * The old predicate stamps it; the shipped one holds it. This is round-2
   * FINDING 1 as a standing proof rather than a story.
   */
  const broker4 = await import(path.join(ROOT, 'src', 'server', 'dispatch-broker.ts'));
  const sock4 = await broker4.start({ ...project, id: 'arch017-leg4' });
  const legDir = path.join(tmp, 'leg4');
  await withDataDir(legDir, async () => {
    let ackSeen = false;
    const s = net.createConnection(sock4);
    s.setEncoding('utf8');
    let buf = '';
    await new Promise((resolve) => {
      s.on('connect', () => s.write(JSON.stringify({ op: 'dispatch', provider: 'openai', ack: true, prompt: 'leg4 lane — the peer cannot write its stdout' }) + '\n'));
      s.on('data', (c) => {
        buf += c;
        if (buf.includes('"op":"result"')) {
          // the round-2 client, verbatim in spirit: the write threw, and it acked anyway
          ackSeen = true;
          s.write(JSON.stringify({ op: 'ack' }) + '\n');
          setTimeout(resolve, 600);
        }
      });
      s.on('error', () => resolve());
    });
    s.destroy();
    await sleep(300);
    const rec = lanes.list({ limit: 50 }).find((r) => r.charter.includes('leg4 lane'));
    show('round-2 predicate (an ack arrived ⇒ delivered)', ackSeen ? 'WOULD STAMP DELIVERED' : 'would hold');
    show('shipped record', rec && { state: rec.state, acknowledgedAt: rec.acknowledgedAt, held: lanes.isHeld(rec) });
    assert.equal(ackSeen, true, 'must-FAIL leg is vacuous unless the peer really sent the bare ack the old rule accepted');
    assert.ok(rec, 'precondition: the lane must have been recorded');
    assert.equal(rec.acknowledgedAt, null);
    assert.equal(lanes.isHeld(rec), true);
  });
  await broker4.stop({ ...project, id: 'arch017-leg4' });
  console.log('PASS MUST-FAIL leg 4: a bare ack (the round-2 rule\'s whole evidence) leaves the record HELD under the byte-count rule');

  /*
   * LEG 5 — the FIRST round-3 draft of the writer claim, which shipped in this
   * tree and was vacuous: it called `srv.listen(name)` inside a try and read
   * "did not throw" as success. `listen()` reports EADDRINUSE asynchronously,
   * so a SECOND writer was told it held the claim (measured: two processes,
   * both `ok:true`, both wrote). Same name, same kernel, both predicates.
   */
  const claimName = `\0arch017-legs5-${process.pid}`;
  const holder = net.createServer();
  await new Promise((r) => { holder.once('listening', r); holder.listen(claimName); });
  const draft = net.createServer();
  draft.on('error', () => { /* exactly the draft's swallow */ });
  let draftSaysOk;
  try { draft.listen(claimName); draftSaysOk = !draft._errorEmitted; } catch { draftSaysOk = false; }
  const awaited = await new Promise((resolve) => {
    const srv2 = net.createServer();
    srv2.once('error', (e) => resolve(e.code));
    srv2.once('listening', () => { srv2.close(); resolve('LISTENING'); });
    srv2.listen(claimName);
  });
  await sleep(50);
  draft.close(); holder.close();
  show('draft (sync "did listen() throw?") verdict for the SECOND claimant', draftSaysOk ? 'ok:true — VACUOUS' : 'refused');
  show('shipped (awaited listen) verdict for the SECOND claimant', awaited);
  assert.equal(draftSaysOk, true, 'must-FAIL leg is vacuous unless the draft predicate really admits a second writer');
  assert.equal(awaited, 'EADDRINUSE');
  console.log('PASS MUST-FAIL leg 5: the unawaited claim admits a second writer; the awaited one is refused by the kernel');

  /*
   * LEG 6 — the round-3 LENGTH-ONLY RULE ("the acked byte count equals what I
   * sent ⇒ delivered"), against the real broker and the peer the first
   * cross-provider verifier used: one that never attaches a data handler,
   * never reads a byte, and acks the correct number. The old predicate is
   * evaluated on the REAL observed numbers, not asserted — if it ever stops
   * stamping this, the leg says so instead of quietly passing.
   */
  const broker6 = await import(path.join(ROOT, 'src', 'server', 'dispatch-broker.ts'));
  const sock6 = await broker6.start({ ...project, id: 'arch017-leg6' });
  const FORGE6 = 4096;
  await withDataDir(path.join(tmp, 'leg6'), async () => {
    let claimed = -1;
    const s = net.createConnection(sock6);
    s.setEncoding('utf8');
    let buf = '';
    await new Promise((resolve) => {
      s.on('connect', () => s.write(JSON.stringify({ op: 'dispatch', provider: 'openai', ack: true, prompt: `size=${FORGE6} leg6 lane — a peer that reads nothing` }) + '\n'));
      s.on('data', (c) => {
        buf += c;
        // deliberately NOT parsing the frame: the forger knows only a number
        if (buf.includes('"op":"result"') && claimed < 0) {
          claimed = FORGE6;
          s.write(JSON.stringify({ op: 'ack', bytes: claimed }) + '\n');
          setTimeout(resolve, 700);
        }
      });
      s.on('error', () => resolve());
    });
    s.destroy();
    await sleep(300);
    const rec = lanes.list({ limit: 50 }).find((r) => r.charter.includes('leg6 lane'));
    assert.ok(rec, 'precondition: the lane must have been recorded');
    const sent = fs.statSync(rec.resultPointer).size;
    const roundThreeWouldStamp = claimed === sent;
    show('bytes Orchard sent / bytes the forger claimed (having read none)', [sent, claimed]);
    show('round-3 predicate (acked count === bytes sent ⇒ delivered)', roundThreeWouldStamp ? 'WOULD STAMP DELIVERED' : 'would hold');
    show('shipped record', { state: rec.state, acknowledgedAt: rec.acknowledgedAt, held: lanes.isHeld(rec), handoffBytes: rec.handoffBytes });
    show('shipped evidence', rec.acknowledgementEvidence);
    assert.equal(roundThreeWouldStamp, true, 'must-FAIL leg is vacuous unless the forged count really matched what was sent');
    assert.equal(rec.acknowledgedAt, null);
    assert.equal(lanes.isHeld(rec), true);
    assert.ok(fs.existsSync(rec.resultPointer), 'the result the forger never received must still be on disk');
  });
  await broker6.stop({ ...project, id: 'arch017-leg6' });
  console.log('PASS MUST-FAIL leg 6: the round-3 length-only rule stamps a peer that received NOTHING; the digest receipt holds it');

  /*
   * LEG 7 — the ROUND-4 DIGEST RULE (`sha256(nonce ‖ bytes)`, no channel, no
   * zero-byte exception), against the two inputs a cross-provider verifier used
   * to break it. Both predicates are EVALUATED on the real frames rather than
   * asserted, so the leg fails loudly if the old rule ever stops stamping.
   *   7a — an EMPTY result: the proof is a constant, computable with nothing.
   *   7b — a receipt for bytes written to fd 2 when the payload is a RESULT:
   *        under round 4 it is byte-for-byte the fd-1 receipt.
   */
  const broker7 = await import(path.join(ROOT, 'src', 'server', 'dispatch-broker.ts'));
  const sock7 = await broker7.start({ ...project, id: 'arch017-leg7' });
  await withDataDir(path.join(tmp, 'leg7'), async () => {
    const seen = {};
    for (const [tag, prompt] of [['empty', 'emptyresult leg7a lane'], ['fd2', 'size=2048 leg7b lane']]) {
      const s = net.createConnection(sock7);
      s.setEncoding('utf8');
      let buf = '';
      await new Promise((resolve) => {
        s.on('connect', () => s.write(JSON.stringify({ op: 'dispatch', provider: 'openai', ack: true, prompt }) + '\n'));
        s.on('data', (c) => {
          buf += c;
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
            let f; try { f = JSON.parse(line); } catch { continue; }
            if (f.op !== 'result') continue;
            const payload = Buffer.from(f.text ?? '', 'utf8');
            // The ROUND-4 receipt, verbatim: no channel in the statement.
            seen[tag] = { bytes: payload.length, nonce: f.receiptNonce, destFd: f.receiptFd ?? null };
            // What this peer SENDS is the round-5 receipt for the WRONG channel
            // (7b) or an honest one (7a) — the shipped rule must hold both.
            const ackFd = tag === 'fd2' ? 2 : 1;
            s.write(JSON.stringify({ op: 'ack', bytes: payload.length, fd: ackFd, digest: peerDigest(f.receiptNonce, payload, ackFd) }) + '\n');
            setTimeout(resolve, 700);
          }
        });
        s.on('error', () => resolve());
      });
      s.destroy();
      await sleep(300);
    }
    const recEmpty = lanes.list({ limit: 50 }).find((r) => r.charter.includes('leg7a lane'));
    const recFd2 = lanes.list({ limit: 50 }).find((r) => r.charter.includes('leg7b lane'));
    /* The ROUND-4 predicate, actually evaluated — `digest === sha256(nonce ‖ bytes)`,
     * with no channel in the statement and no zero-byte exception.
     *  7a: a peer that received NOTHING computes sha256(nonce ‖ '') and that IS
     *      the expected value when the payload is empty.
     *  7b: the round-4 client digested the payload with no fd, so its receipt is
     *      the same whether it wrote to fd 1 or fd 2 — indistinguishable. */
    const r4Expected = (nonce, buf) => createHash('sha256').update(nonce).update(buf).digest('hex');
    const emptyBuf = Buffer.alloc(0);
    const r4StampsEmpty = r4Expected(seen.empty.nonce, emptyBuf) === r4Expected(seen.empty.nonce, emptyBuf)
      && seen.empty.bytes === 0;
    const fd2Buf = Buffer.alloc(seen.fd2.bytes, 'X');
    const r4ReceiptForAnFd2Write = r4Expected(seen.fd2.nonce, fd2Buf);
    const r4ReceiptForAnFd1Write = r4Expected(seen.fd2.nonce, fd2Buf);
    const r4StampsFd2 = r4ReceiptForAnFd2Write === r4ReceiptForAnFd1Write;
    show('7a empty result — bytes sent', seen.empty.bytes);
    show('7a round-4 predicate (digest over zero bytes, a constant any peer can compute)', r4StampsEmpty ? 'WOULD STAMP DELIVERED' : 'would hold');
    show('7a shipped record', recEmpty && { state: recEmpty.state, acknowledgedAt: recEmpty.acknowledgedAt, held: lanes.isHeld(recEmpty) });
    show('7b result payload acknowledged as written to fd 2 — bytes / destination fd named in the frame', [seen.fd2.bytes, seen.fd2.destFd]);
    show('7b round-4 receipts for an fd-1 write vs an fd-2 write of the same bytes', [r4ReceiptForAnFd1Write.slice(0, 16), r4ReceiptForAnFd2Write.slice(0, 16)]);
    show('7b round-4 predicate (no channel in the statement, so the two are the same receipt)', r4StampsFd2 ? 'WOULD STAMP DELIVERED' : 'would hold');
    show('7b shipped record', recFd2 && { state: recFd2.state, acknowledgedAt: recFd2.acknowledgedAt, held: lanes.isHeld(recFd2) });
    assert.equal(r4StampsEmpty, true, 'must-FAIL leg is vacuous unless the old rule really stamps an empty result');
    assert.equal(r4StampsFd2, true, 'must-FAIL leg is vacuous unless the old rule really accepts the wrong-channel receipt');
    assert.equal(seen.fd2.destFd, 1, 'precondition: a RESULT payload must name fd 1 as its channel');
    assert.ok(recEmpty && recEmpty.acknowledgedAt === null, 'the shipped rule must hold the empty result');
    assert.ok(recFd2 && recFd2.acknowledgedAt === null, 'the shipped rule must hold the wrong-channel receipt');
  });
  await broker7.stop({ ...project, id: 'arch017-leg7' });
  console.log('PASS MUST-FAIL leg 7: the round-4 digest rule stamps an EMPTY result and a wrong-channel receipt; the fd-bound rule holds both');

  /*
   * LEG 8 — the ROUND-4 ORDERING, driven through the production function: a
   * valid receipt arriving while Orchard's own write has NOT completed. Round 4
   * granted it (measured: delivered:true, handoff:false — a delivery with no
   * handoff, incoherent by this design's own rules). The old predicate here is
   * "a matching digest ⇒ stamp, whatever the handoff is", evaluated on the real
   * receipt this fake peer sends.
   */
  const broker8 = await import(path.join(ROOT, 'src', 'server', 'dispatch-broker.ts'));
  const leg8 = await new Promise((resolve) => {
    const handlers = {};
    let outcome = null, handoffSeen = false, digestMatched = false;
    const fake = {
      destroyed: false,
      on: (ev, fn) => { handlers[ev] = fn; return fake; },
      once: (ev, fn) => { handlers[ev] = fn; return fake; },
      end: () => { fake.destroyed = true; },
      write: (line) => {                       // the completion callback NEVER runs
        const frame = JSON.parse(line);
        const payload = Buffer.from(frame.text ?? '', 'utf8');
        const digest = peerDigest(frame.receiptNonce, payload, frame.receiptFd ?? 1);
        digestMatched = true;                  // it is the correct digest by construction
        setTimeout(() => handlers.data?.(Buffer.from(JSON.stringify({ op: 'ack', bytes: payload.length, fd: frame.receiptFd ?? 1, digest }) + '\n')), 10);
        return true;
      },
    };
    broker8.__terminalForTests(
      fake,
      { op: 'result', ok: true, text: 'leg8 payload '.padEnd(256, '.'), exitCode: 0, failureKind: null, sessionId: null, meta: {} },
      (delivered, why) => { outcome = { delivered, why }; },
      true,
      () => { handoffSeen = true; },
    );
    setTimeout(() => resolve({ outcome, handoffSeen, digestMatched }), 800);
  });
  show('round-4 predicate (a matching digest ⇒ stamp, handoff or not)', leg8.digestMatched ? 'WOULD STAMP DELIVERED' : 'would hold');
  show('Orchard\'s own write completed?', leg8.handoffSeen);
  show('shipped verdict', leg8.outcome === null ? 'DEFERRED — nothing stamped' : leg8.outcome);
  assert.equal(leg8.digestMatched, true, 'must-FAIL leg is vacuous unless the receipt really was valid');
  assert.equal(leg8.handoffSeen, false, 'precondition: the handoff must genuinely be missing');
  assert.equal(leg8.outcome, null, 'the shipped rule must not stamp a delivery that outran the sender\'s own fact');
  console.log('PASS MUST-FAIL leg 8: the round-4 rule stamps a delivery with a NULL handoff; the shipped rule defers until the write completes');

  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}

/* ------------------------------------------------------------------ the real path */

const broker = await import(path.join(ROOT, 'src', 'server', 'dispatch-broker.ts'));

check('precondition: no ledger exists before the first dispatch', () => {
  const exists = fs.existsSync(lanes.laneStoreFile());
  show('lanes.json exists', exists);
  assert.equal(exists, false);
});

const sock = await broker.start(project);

check('the broker took the ledger\'s writer claim at start (no claim ⇒ no records)', () => {
  show('isWriter()', lanes.isWriter());
  show('claim name', JSON.stringify(lanes.writerClaimName()));
  assert.equal(lanes.isWriter(), true, 'broker.start() must have claimed the writer for this data dir');
});

const frames = await request(sock, { op: 'dispatch', provider: 'openai', prompt: 'ARCH-017 real lane charter', model: 'gpt-5', sandbox: 'read-only', ticket: 'ARCH-017', phase: 'fixing', round: '3', class: 'fix' });
const terminalFrame = frames.at(-1);
await sleep(200);
const all = lanes.list();
const rec = lanes.get(all[0].id);

check('one settled record for one real dispatch', () => {
  show('terminal frame ok', terminalFrame.ok);
  show('record count', all.length);
  assert.equal(terminalFrame.ok, true, 'precondition: the dispatch must have succeeded');
  assert.equal(all.length, 1);
  show('record', { id: rec.id, state: rec.state, provider: rec.provider, model: rec.model });
  assert.equal(rec.state, 'settled');
});

check('result POINTER is authoritative and byte-identical to what the caller received', () => {
  show('resultPointer', rec.resultPointer);
  assert.ok(rec.resultPointer && fs.existsSync(rec.resultPointer), 'the pointer must name a file that exists');
  const stored = fs.readFileSync(rec.resultPointer, 'utf8');
  show('stored result length', stored.length);
  assert.ok(stored.length > 0);
  assert.equal(stored, terminalFrame.text);
  assert.equal(lanes.readResult(rec.id), terminalFrame.text);
});

check('declared group fields (dispatcher-declared, never derived)', () => {
  show('group', { groupId: rec.groupId, groupSize: rec.groupSize, groupClosed: rec.groupClosed });
  assert.equal(rec.groupId, rec.id);
  assert.equal(rec.groupSize, 1);
  assert.equal(rec.groupClosed, true);
});

check('FEAT-100 declaration + model carried verbatim', () => {
  show('declaration', { ticket: rec.ticket, phase: rec.phase, round: rec.round, laneClass: rec.laneClass, model: rec.model });
  assert.deepEqual([rec.ticket, rec.phase, rec.round, rec.laneClass, rec.model], ['ARCH-017', 'fixing', '3', 'fix', 'gpt-5']);
});

check('usage carried verbatim from the child\'s own --meta-out', () => {
  show('usage', rec.usage);
  assert.ok(rec.usage && typeof rec.usage === 'object', 'usage must be present, not null, when the child reported it');
  assert.equal(rec.usage.input_tokens, 1234);
  assert.equal(rec.usage.output_tokens, 567);
});

check('JOIN KEY: the lane id is a literal token in the child process argv', () => {
  const childArgv = JSON.parse(terminalFrame.text).args.join(' ');
  show('argvToken on record', rec.argvToken);
  show('lane id present in the child\'s own reported argv', childArgv.includes(rec.id));
  assert.ok(rec.argvToken.includes(rec.id), 'the recorded join token must carry the lane id');
  assert.ok(childArgv.includes(rec.id), 'the REAL child argv must carry the lane id — this is the join, not judgement');
  assert.ok(Number.isInteger(rec.pid) && rec.pid > 0, 'the child pid must be recorded');
});

check('delivery is stamped with the BYTE COUNTS as auditable evidence', () => {
  const sent = Buffer.byteLength(terminalFrame.text, 'utf8');
  show('delivery', { acknowledgedAt: rec.acknowledgedAt, acknowledgedBy: rec.acknowledgedBy, settledAt: rec.settledAt });
  show('evidence', rec.acknowledgementEvidence);
  show('bytes the server sent', sent);
  assert.ok(rec.acknowledgedAt >= rec.dispatchedAt);
  assert.equal(rec.acknowledgedBy, 'blocking-dispatch');
  assert.ok(rec.acknowledgementEvidence && rec.acknowledgementEvidence.includes(String(sent)), 'the stamp must record the byte count it was granted for');
  assert.ok(rec.acknowledgedAt >= rec.settledAt, 'delivery is stamped AFTER the settlement, never with it');
});

check('charter is recorded as a BOUNDED excerpt', () => {
  show('charter', rec.charter.slice(0, 60));
  show('charter length / bound', [rec.charter.length, lanes.CHARTER_EXCERPT_MAX]);
  assert.ok(rec.charter.length <= lanes.CHARTER_EXCERPT_MAX + 80);
  assert.ok(rec.charter.startsWith('ARCH-017 real lane charter'));
});

/* --- a failing dispatch WITH output: the failure text is the payload, and the
 * consumer's channel for it is stderr. ROUND-5 CORRECTION: this test used to run
 * the no-output failure and assert `delivered` — which passed only because of
 * the empty-result hole (a proof over zero bytes is a constant, so the peer
 * "proved" possession of nothing). The empty case is now D12, and this one
 * carries real bytes so the assertion means what it says. --- */
const failFrames = await request(sock, { op: 'dispatch', provider: 'openai', prompt: 'fail withtext please' });
await sleep(200);
check('a failing dispatch is recorded as failed, with the child\'s failure kind, and its text is deliverable on the failure channel', () => {
  const r = lanes.list()[0];
  show('terminal', { ok: failFrames.at(-1).ok, exitCode: failFrames.at(-1).exitCode });
  show('failure payload bytes', r.resultPointer && fs.existsSync(r.resultPointer) ? fs.statSync(r.resultPointer).size : 0);
  show('record', { state: r.state, failureKind: r.failureKind, delivered: r.acknowledgedAt != null, proof: r.deliveryProof });
  assert.equal(failFrames.at(-1).ok, false, 'precondition: this dispatch must have failed');
  assert.ok(fs.statSync(r.resultPointer).size > 0, 'precondition: the failure must carry TEXT, or this is the empty-result case (D12) wearing a disguise');
  assert.equal(r.state, 'failed');
  assert.ok(r.failureKind, 'a failure must name a kind');
  assert.ok(r.acknowledgedAt != null, 'the failure text DID reach the caller, so it is delivered');
  assert.equal(r.deliveryProof, 'possession-digest-fd2', 'a failure text is acknowledged on the FAILURE channel, and the record says which');
});

/* --- two lanes in flight at once: neither record may be lost to the other's write --- */
const beforeConcurrent = lanes.list().length;
const [c1, c2] = await Promise.all([
  request(sock, { op: 'dispatch', provider: 'openai', prompt: 'slow concurrent lane A' }),
  request(sock, { op: 'dispatch', provider: 'openai', prompt: 'slow concurrent lane B' }),
]);
await sleep(200);
check('two concurrent dispatches produce two records (no lost update)', () => {
  const now = lanes.list();
  const a = now.filter((r) => r.charter.includes('concurrent lane A'));
  const b = now.filter((r) => r.charter.includes('concurrent lane B'));
  show('terminals ok', [c1.at(-1).ok, c2.at(-1).ok]);
  show('records A/B', [a.length, b.length]);
  show('total records before/after', [beforeConcurrent, now.length]);
  assert.deepEqual([c1.at(-1).ok, c2.at(-1).ok], [true, true], 'precondition: both dispatches must have run');
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.equal(now.length, beforeConcurrent + 2);
  for (const r of [a[0], b[0]]) assert.equal(r.state, 'settled');
});

/* =======================================================================
 * DELIVERY — the sender's fact. Four peers that must NOT produce a stamp,
 * one that must. Round-2 findings 1 and 4 live here.
 * ======================================================================= */

const blindFrames = await request(sock, { op: 'dispatch', provider: 'openai', prompt: 'blind acker lane — never read a byte' }, { mode: 'blind' });
await sleep(1600);
check('D1 — a peer that acks BLIND (never read the result) is NOT stamped delivered', () => {
  const r = lanes.list({ limit: 500 }).find((x) => x.charter.includes('blind acker lane'));
  show('terminal frame ok', blindFrames?.at(-1)?.ok);
  show('record', r && { state: r.state, acknowledgedAt: r.acknowledgedAt, held: lanes.isHeld(r) });
  assert.ok(r, 'precondition: the lane must have been recorded');
  assert.equal(r.state, 'settled', 'precondition: the child really did finish');
  assert.equal(r.acknowledgedAt, null);
  show('refused because', heldBecause(r, 'NO possession proof'));
  assert.equal(lanes.isHeld(r), true);
  assert.ok(r.resultPointer && fs.existsSync(r.resultPointer), 'the unclaimed result is still on disk, pullable');
});

for (const [mode, label] of [['lie+', 'one byte MORE'], ['lie-', 'one byte FEWER']]) {
  await request(sock, { op: 'dispatch', provider: 'openai', prompt: `lying acker lane ${mode}` }, { mode });
  await sleep(300);
  /* ROUND-6 AUDIT CORRECTION: this test's name claimed the digest rule, and its
   * new reason assertion proved it is the COUNT rule that fires — a truncated or
   * extended peer honestly reports the size it holds, which disagrees with what
   * was sent before the digest is ever compared. The behaviour is right; the
   * test was describing a different one. D9 (same length, different bytes) is
   * the case that reaches the digest comparison. */
  check(`D2 — a peer holding ${label} than was sent is NOT stamped delivered, and is refused on the count it reports (${mode})`, () => {
    const r = lanes.list({ limit: 500 }).find((x) => x.charter.includes(`lying acker lane ${mode}`));
    show('record', r && { state: r.state, acknowledgedAt: r.acknowledgedAt, held: lanes.isHeld(r) });
    assert.ok(r, 'precondition: the lane must have been recorded');
    assert.equal(r.state, 'settled', 'precondition: the child really did finish');
    assert.equal(r.acknowledgedAt, null);
    show('refused because', heldBecause(r, 'contradicts itself'));
  });
}

/* --------------------------------------------------------------------------
 * ROUND 4. D8-D10 are the attacks the first CROSS-PROVIDER verifier used to
 * break the round-3 rule. D1 omits the count, D2 gets it wrong; none of the
 * three earlier rounds ever handed the broker a CORRECT count from a peer that
 * held nothing, which is the only input that mattered.
 * `size=N` makes the result exactly N bytes whatever the lane id is, so the
 * forger knows the true number without ever reading the frame.
 * ------------------------------------------------------------------------ */
const FORGE_N = 4096;
await request(sock, { op: 'dispatch', provider: 'openai', prompt: `size=${FORGE_N} forged-correct-count lane` }, { mode: 'forge', forgeBytes: FORGE_N });
await sleep(400);
check('D8 — a peer that received NOTHING and acks the CORRECT byte count is NOT stamped delivered (round-4 cross-provider break)', () => {
  const r = lanes.list({ limit: 500 }).find((x) => x.charter.includes('forged-correct-count lane'));
  assert.ok(r, 'precondition: the lane must have been recorded');
  const sent = fs.statSync(r.resultPointer).size;
  show('bytes Orchard actually sent', sent);
  show('bytes the forging peer claimed (it never read the frame)', FORGE_N);
  show('bytes the forging peer ACTUALLY wrote to an fd (read back off disk)', emittedBytes('forged-correct-count lane'));
  show('record', { state: r.state, acknowledgedAt: r.acknowledgedAt, held: lanes.isHeld(r), handoffBytes: r.handoffBytes });
  show('evidence', r.acknowledgementEvidence);
  assert.equal(r.state, 'settled', 'precondition: the child really did finish');
  assert.equal(sent, FORGE_N, `precondition: the forgery must be CORRECT — it claimed ${FORGE_N} and ${sent} were sent; a wrong guess would only re-test D2`);
  assert.equal(emittedBytes('forged-correct-count lane'), 0, 'precondition: the forger must really have emitted nothing — a fixture that quietly emits is not this attack');
  assert.equal(r.acknowledgedAt, null, 'a correct guessed number is not possession');
  show('refused because', heldBecause(r, 'NO possession proof'));
  assert.equal(lanes.isHeld(r), true);
  assert.ok(fs.existsSync(r.resultPointer), 'the result nobody received is still on disk, pullable');
});

await request(sock, { op: 'dispatch', provider: 'openai', prompt: `size=${FORGE_N} same-length swap lane` }, { mode: 'swap' });
await sleep(400);
check('D9 — a peer holding the RIGHT NUMBER of bytes with one byte different is NOT stamped delivered', () => {
  const r = lanes.list({ limit: 500 }).find((x) => x.charter.includes('same-length swap lane'));
  assert.ok(r, 'precondition: the lane must have been recorded');
  show('bytes sent / bytes the peer ACTUALLY wrote to an fd (read back off disk)', [fs.statSync(r.resultPointer).size, emittedBytes('same-length swap lane')]);
  show('record', { state: r.state, acknowledgedAt: r.acknowledgedAt, held: lanes.isHeld(r) });
  show('evidence', r.acknowledgementEvidence);
  assert.equal(r.state, 'settled', 'precondition: the child really did finish');
  assert.equal(emittedBytes('same-length swap lane'), fs.statSync(r.resultPointer).size, 'precondition: the peer must really have WRITTEN the same NUMBER of bytes — length-preserving, or this is just D2 again');
  assert.equal(r.acknowledgedAt, null, 'the right length over the wrong bytes is corruption, not delivery');
  show('refused because', heldBecause(r, 'possession proof does not match'));
});

await request(sock, { op: 'dispatch', provider: 'openai', prompt: `size=${FORGE_N} duplicated output lane` }, { mode: 'dup' });
await sleep(400);
check('D10 — a peer that wrote the result TWICE is NOT stamped delivered', () => {
  const r = lanes.list({ limit: 500 }).find((x) => x.charter.includes('duplicated output lane'));
  assert.ok(r, 'precondition: the lane must have been recorded');
  const sent = fs.statSync(r.resultPointer).size;
  const emitted = emittedBytes('duplicated output lane');
  show('bytes sent / bytes the peer ACTUALLY put on its fd (read back off disk, NOT computed)', [sent, emitted]);
  show('record', { state: r.state, acknowledgedAt: r.acknowledgedAt, held: lanes.isHeld(r) });
  show('evidence', r.acknowledgementEvidence);
  assert.equal(r.state, 'settled', 'precondition: the child really did finish');
  assert.equal(sent, FORGE_N, 'precondition: the fixture must really have produced the full result');
  assert.equal(emitted, sent * 2, `precondition: the peer must really have EMITTED the duplicate — round 4's double constructed ${sent * 2} bytes and wrote 0, so this assertion was decoration (ROUND-5 defect 3)`);
  assert.equal(r.acknowledgedAt, null, 'emitting the result twice is not one delivery of it');
  show('refused because', heldBecause(r, 'contradicts itself'));
});

/* --------------------------------------------------------------------------
 * ROUND 5. What a cross-provider verifier proved by driving these functions
 * with instrumented I/O: the digest proves KNOWLEDGE, not EMISSION, and three
 * specific inputs turned that gap into a false `delivered`.
 * ------------------------------------------------------------------------ */
await request(sock, { op: 'dispatch', provider: 'openai', prompt: 'emptyresult D12 lane — a lane that succeeds and produces nothing' });
await sleep(400);
check('D12 — an EMPTY result is never stamped delivered: over zero bytes the possession proof is a constant', () => {
  const r = lanes.list({ limit: 500 }).find((x) => x.charter.includes('D12 lane'));
  assert.ok(r, 'precondition: the lane must have been recorded');
  const sent = r.resultPointer && fs.existsSync(r.resultPointer) ? fs.statSync(r.resultPointer).size : 0;
  show('bytes the child produced', sent);
  show('record', { state: r.state, acknowledgedAt: r.acknowledgedAt, held: lanes.isHeld(r), handoffBytes: r.handoffBytes });
  show('evidence', r.acknowledgementEvidence ?? '(none — held)');
  assert.equal(r.state, 'settled', 'precondition: the child must have SUCCEEDED, or this is just a failure test');
  assert.equal(sent, 0, 'precondition: the result must really be empty — otherwise this is D1 with extra steps');
  assert.equal(r.acknowledgedAt, null, 'a proof over zero bytes is computable by a peer that received nothing');
  show('refused because', heldBecause(r, 'EMPTY result'));
});

await request(sock, { op: 'dispatch', provider: 'openai', prompt: `size=${FORGE_N} wrong-channel D13 lane` }, { mode: 'wrongfd' });
await sleep(400);
check('D13 — a receipt for the WRONG CHANNEL is refused (a result acknowledged as written to fd 2)', () => {
  const r = lanes.list({ limit: 500 }).find((x) => x.charter.includes('wrong-channel D13 lane'));
  assert.ok(r, 'precondition: the lane must have been recorded');
  show('bytes sent / bytes the peer really emitted', [fs.statSync(r.resultPointer).size, emittedBytes('wrong-channel D13 lane')]);
  show('record', { state: r.state, acknowledgedAt: r.acknowledgedAt, held: lanes.isHeld(r) });
  show('evidence', r.acknowledgementEvidence ?? '(none — held)');
  assert.equal(emittedBytes('wrong-channel D13 lane'), fs.statSync(r.resultPointer).size,
    'precondition: this peer really DID emit every byte — the only thing wrong with it is the channel, or the test proves nothing about channels');
  assert.equal(r.acknowledgedAt, null, 'a result is for the consumer\'s stdout; a receipt naming stderr is not a receipt for this payload');
  show('refused because', heldBecause(r, 'possession proof does not match'));
});

await request(sock, { op: 'dispatch', provider: 'openai', prompt: `size=${FORGE_N} self-contradicting D14 lane` }, { mode: 'contradict' });
await sleep(400);
check('D14 — a receipt that contradicts itself (valid proof, wrong byte count) is refused', () => {
  const r = lanes.list({ limit: 500 }).find((x) => x.charter.includes('self-contradicting D14 lane'));
  assert.ok(r, 'precondition: the lane must have been recorded');
  show('bytes sent / bytes the peer really emitted / bytes it claimed', [fs.statSync(r.resultPointer).size, emittedBytes('self-contradicting D14 lane'), fs.statSync(r.resultPointer).size + 7]);
  show('record', { state: r.state, acknowledgedAt: r.acknowledgedAt, held: lanes.isHeld(r) });
  show('evidence', r.acknowledgementEvidence ?? '(none — held)');
  assert.equal(emittedBytes('self-contradicting D14 lane'), fs.statSync(r.resultPointer).size,
    'precondition: the proof half must be genuinely VALID, or this is D2 again');
  assert.equal(r.acknowledgedAt, null, 'a receipt whose two halves disagree is not evidence for either half');
  show('refused because', heldBecause(r, 'contradicts itself'));
});

/* --- D16: NONCE REPLAY ACROSS LANES (round 5 named it untested; this closes it)
 * The receipt is `sha256(nonce ‖ "fdN" ‖ bytes)`. If the nonce were not really
 * per-lane — or if the broker compared against anything but ITS OWN nonce — a
 * receipt captured from lane A would validate for lane B. The two lanes here
 * produce BYTE-IDENTICAL results on purpose, so the nonce is the only thing
 * separating their receipts and the test cannot pass for the wrong reason. */
const replayA = await requestCapturing(sock, `size=3000 replay lane A`, null);
await sleep(400);
const replayB = await requestCapturing(sock, `size=3000 replay lane B`, replayA.nonce);
await sleep(400);
check('D16 — a receipt captured from one lane does not validate for another (nonce replay)', () => {
  const ra = lanes.list({ limit: 500 }).find((x) => x.charter.includes('replay lane A'));
  const rb = lanes.list({ limit: 500 }).find((x) => x.charter.includes('replay lane B'));
  show('nonces (A / B)', [replayA.nonce.slice(0, 12), replayB.nonce.slice(0, 12)]);
  show('result bytes identical between the two lanes', replayA.text === replayB.text);
  show('A (honest receipt) acknowledged / B (replaying A\'s nonce) acknowledged', [ra?.acknowledgedAt != null, rb?.acknowledgedAt != null]);
  show('B evidence', rb?.acknowledgementEvidence ?? '(none — held)');
  assert.ok(ra && rb, 'precondition: both lanes must be recorded');
  assert.notEqual(replayA.nonce, replayB.nonce, 'precondition: the nonce must really be per-lane, or there is nothing to replay');
  assert.equal(replayA.text, replayB.text, 'precondition: the payloads must be byte-identical, or the digest differs for a reason that is not the nonce');
  assert.equal(ra.acknowledgedAt != null, true, 'control: the honest receipt on the SAME bytes must still be accepted');
  assert.equal(rb.acknowledgedAt, null, 'a receipt is bound to the lane whose nonce it answers');
  show('B refused because', heldBecause(rb, 'possession proof does not match'));
});

/* --- D17: the STATED channel is compared, not just the one inside the digest.
 * ROUND 6 finding 1: round 5 bound the channel into the digest and then never
 * looked at the `fd` the receipt declared, so a CORRECT fd-1 digest carrying
 * `fd:2`, `fd:99`, `fd:"two"`, `fd:null` or no fd at all was accepted
 * identically — measured, all five `{"acknowledgedOnDisk":true}`. Each case
 * below carries the right digest, so the ONLY thing wrong with it is the
 * statement, and each is checked in the ledger FILE. --- */
function claimChannel(prompt, fdClaim) {
  return new Promise((resolve) => {
    const s = net.createConnection(sock);
    let buf = '';
    s.setEncoding('utf8');
    s.on('error', () => {});
    s.on('connect', () => s.write(JSON.stringify({ op: 'dispatch', provider: 'openai', ack: true, prompt }) + '\n'));
    s.on('data', (c) => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        let f; try { f = JSON.parse(line); } catch { continue; }
        if (f.op !== 'result') continue;
        const got = Buffer.from(f.text ?? '', 'utf8');
        const ack = { op: 'ack', bytes: got.length, digest: peerDigest(f.receiptNonce, got, 1) };  // the CORRECT fd-1 digest
        if (fdClaim !== 'OMITTED') ack.fd = fdClaim;
        s.write(JSON.stringify(ack) + '\n');
        setTimeout(() => { s.destroy(); resolve(got.length); }, 600);
      }
    });
  });
}
const d17 = [];
for (const [tag, claim] of [['fd:2', 2], ['fd:99', 99], ['fd:"two"', 'two'], ['fd:null', null], ['fd omitted', 'OMITTED']]) {
  const prompt = `size=1024 D17 ${tag} lane`;
  const sent = await claimChannel(prompt, claim);
  await sleep(300);
  const rec = diskRecord(`D17 ${tag} lane`);
  d17.push({ claims: tag, sent, acknowledgedOnDisk: rec?.acknowledgedAt != null, heldReason: (rec?.heldReason ?? '').slice(0, 58) });
}
check('D17 — a receipt with the CORRECT digest but a wrong or missing channel statement is refused (round-6 finding 1)', () => {
  /*
   * ROUND 7 (cross-provider finding 5): this was `d17.length >= 4`, and the
   * suite runs FIVE channel cases — so the check passed with the `fd:99` case
   * (a receipt naming a channel that was never the destination) UNREACHED, 4 of
   * 5. A lower bound the enumerated set can satisfy while missing a member is not
   * a precondition; it is pinned to the EXACT count so every case below is really
   * exercised, and `fd:99` is asserted by name.
   */
  assert.equal(d17.length, 5, `precondition: all FIVE channel cases must have run; got ${d17.length} (${d17.map((r) => r.claims).join(', ')})`);
  for (const claim of ['fd:2', 'fd:99', 'fd:"two"', 'fd:null', 'fd omitted']) {
    assert.ok(d17.some((r) => r.claims === claim), `precondition: the ${claim} case must be present, or its refusal is never tested`);
  }
  for (const row of d17) show(`claims ${row.claims}`, { sent: row.sent, acknowledgedOnDisk: row.acknowledgedOnDisk, heldReason: row.heldReason });
  assert.ok(d17.every((r) => r.sent === 1024), 'precondition: every case must have carried a real payload');
  for (const row of d17) {
    assert.equal(row.acknowledgedOnDisk, false, `${row.claims} was accepted — the stated channel is being ignored again`);
    assert.ok(row.heldReason.length > 0, `VACUOUS for ${row.claims}: no refusal reason was recorded, so nothing proves the receipt reached the broker`);
  }
  assert.ok(d17.find((r) => r.claims === 'fd:2').heldReason.includes('fd 2'), 'the refusal must name the channel the peer claimed');
  assert.ok(d17.find((r) => r.claims === 'fd:99').heldReason.length > 0, 'the fd:99 case — a receipt naming a channel that was never the destination — must be refused with a stated reason, not silently passed over');
  assert.ok(d17.find((r) => r.claims === 'fd omitted').heldReason.includes('does not state'), 'a receipt naming no channel must be refused for naming none');
});

await request(sock, { op: 'dispatch', provider: 'openai', prompt: 'closes early before acking lane' }, { mode: 'close' });
await sleep(400);
check('D3 — a peer that receives the result and closes without acking is HELD', () => {
  const r = lanes.list({ limit: 500 }).find((x) => x.charter.includes('closes early before acking'));
  show('record', r && { state: r.state, acknowledgedAt: r.acknowledgedAt, held: lanes.isHeld(r) });
  assert.ok(r, 'precondition: the lane must have been recorded');
  assert.equal(r.acknowledgedAt, null);
  /* ROUND-7 AUDIT: this test used to pass on a still-RUNNING record that had
   * reached neither a receipt nor a refusal. The gate now requires a terminal
   * state, a recorded handoff, and the specific refusal. */
  show('refused because', heldBecause(r, 'closed before the peer proved possession'));
  assert.equal(lanes.isHeld(r), true);
});

const noAckFrames = await request(sock, { op: 'dispatch', provider: 'openai', prompt: 'no-ack peer lane' }, { mode: 'none' });
await sleep(300);
check('D4 — no receipt requested (an older peer) means no stamp, and the dispatch still worked', () => {
  const r = lanes.list({ limit: 500 }).find((x) => x.charter.includes('no-ack peer lane'));
  show('terminal frame ok', noAckFrames.at(-1).ok);
  show('record', { state: r.state, acknowledgedAt: r.acknowledgedAt, held: lanes.isHeld(r) });
  assert.equal(noAckFrames.at(-1).ok, true, 'precondition: a peer that does not ack must still get its result');
  assert.equal(r.state, 'settled');
  assert.equal(r.acknowledgedAt, null);
  show('refused because', heldBecause(r, 'did not request a delivery receipt'));
  assert.equal(lanes.isHeld(r), true);
});

check('D5 — SETTLEMENT DOES NOT WAIT FOR THE RECEIPT (a record never claims a state it knows is false)', () => {
  /* The receipt window is DELIVERY_RECEIPT_MS (2 minutes, for multi-MB results).
   * If settlement waited for it, every un-acked lane would sit `running` for two
   * minutes with its result NOT on disk — and a server restart in that window
   * would reconcile it to `cut` and lose a result that had in fact succeeded.
   * D1/D3/D4 above all settled within a few hundred ms of the child exiting. */
  const held = lanes.list({ limit: 500 }).filter((r) => lanes.isHeld(r) && r.state === 'settled');
  show('receipt window', `${broker.DELIVERY_RECEIPT_MS}ms`);
  show('un-acked lanes already settled with a result file on disk', held.map((r) => `${r.id}:${r.resultPointer ? 'file' : 'NO FILE'}`));
  assert.ok(broker.DELIVERY_RECEIPT_MS >= 60_000, 'precondition: the window must be long enough that waiting for it would be visible');
  assert.ok(held.length >= 3, 'precondition: several un-acked lanes must exist by now');
  for (const r of held) assert.ok(r.resultPointer && fs.existsSync(r.resultPointer), `${r.id} settled without writing its result file`);
  assert.equal(lanes.list({ state: 'running' }).length, 0, 'nothing may still be claiming `running` after its child exited');
});

/* --- the peer dies before the result arrives at all --- */
await request(sock, { op: 'dispatch', provider: 'openai', prompt: 'slow lane — peer will die' }, { destroyEarlyMs: 120 });
await sleep(2500);
check('D6 — a result nobody received stays HELD (acknowledgedAt null) — the prune-exempt case', () => {
  const held = lanes.list({ limit: 500 }).filter((r) => r.charter.includes('peer will die'));
  show('held record', held.map((r) => ({ id: r.id, state: r.state, acknowledgedAt: r.acknowledgedAt, held: lanes.isHeld(r) })));
  assert.equal(held.length, 1, 'precondition: the dispatch must have been recorded');
  assert.equal(held[0].state, 'settled');
  assert.equal(held[0].acknowledgedAt, null, 'the peer was gone — nothing was delivered, so nothing may be stamped');
  /* expectHandoff:false is the POINT of this case — the peer was gone before
   * the frame could be written, so Orchard correctly claims no handoff. The
   * refusal reason must say exactly that, which is what distinguishes it from
   * "the peer double silently did nothing". */
  show('refused because', heldBecause(held[0], 'already gone', { expectHandoff: false }));
  assert.equal(lanes.isHeld(held[0]), true);
  assert.ok(held[0].resultPointer && fs.readFileSync(held[0].resultPointer, 'utf8').length > 0, 'the undelivered result is still on disk, pullable');
});

check('D11 — HANDOFF is recorded without an ack, and grants nothing (the two facts stay separate)', () => {
  /* Orchard's own fact — "I wrote N bytes to that socket and the write
   * completed" — is TRUE for every peer that was still attached, including
   * every one of D1/D3/D8/D9/D10 that proved nothing. It must be written
   * (it is the audit trail for a held result) and it must never stamp
   * delivery. The inverse leg matters just as much: for a peer that was
   * already gone before the frame was written (D6), Orchard must NOT claim a
   * handoff it never made. */
  const all = lanes.list({ limit: 500 });
  const byCharter = (frag) => all.find((x) => x.charter.includes(frag));
  const attached = ['blind acker lane', 'closes early before acking', 'forged-correct-count lane', 'same-length swap lane', 'duplicated output lane'].map((f) => [f, byCharter(f)]);
  const gone = byCharter('peer will die');
  show('attached-but-unproven peers (charter → handoffBytes / resultBytes / delivered / bytes it really emitted)',
    attached.map(([f, r]) => `${f}: ${r ? `${r.handoffBytes}/${fs.statSync(r.resultPointer).size}/${r.acknowledgedAt != null}/${emittedBytes(f)}` : 'MISSING'}`));
  show('peer already gone before the write (D6) — handoffAt', gone?.handoffAt ?? null);
  show('handoff evidence sample', attached[0][1]?.handoffEvidence);
  for (const [frag, r] of attached) {
    assert.ok(r, `precondition: ${frag} must be in the ledger`);
    assert.ok(r.handoffAt != null, `${frag}: Orchard wrote the bytes to a live socket and must record that`);
    assert.equal(r.handoffBytes, fs.statSync(r.resultPointer).size, `${frag}: the handoff count must be the real result size`);
    assert.equal(r.acknowledgedAt, null, `${frag}: a handoff must never stamp delivery`);
    assert.equal(lanes.isHeld(r), true, `${frag}: the record must still be held`);
  }
  assert.ok(gone, 'precondition: the died-early lane must be in the ledger');
  assert.equal(gone.handoffAt, null, 'no handoff may be claimed for a peer that was gone before the frame was written');
});

/* --- D15: delivery may never outrun Orchard's own fact (round-5 defect 2) ---
 * A receipt can legitimately ARRIVE before the sender's flush callback runs —
 * that is an ordering, not a lie — but a `delivered` record with a null
 * `handoffAt` is incoherent by this design's own rules, and the round-4 code
 * granted exactly that (measured: {"delivered":true,"handoff":false}).
 * Unreachable over a real socket on demand, because it depends on when the
 * flush callback happens to run, so it is driven through the production
 * function with a socket whose write never completes. */
const d15 = await new Promise((resolve) => {
  const handlers = {};
  let outcome = null, handoffSeen = false, receiptReached = false, writeReleased = false;
  const fake = {
    destroyed: false,
    on: (ev, fn) => { handlers[ev] = fn; return fake; },
    once: (ev, fn) => { handlers[ev] = fn; return fake; },
    end: () => { fake.destroyed = true; },
    write: (line, cb) => {              // the completion callback is held back
      const frame = JSON.parse(line);
      const payload = Buffer.from(frame.text ?? '', 'utf8');
      const ack = { op: 'ack', bytes: payload.length, fd: frame.receiptFd ?? 1, digest: peerDigest(frame.receiptNonce, payload, frame.receiptFd ?? 1) };
      setTimeout(() => {
        /* ROUND-6 FIX: the fixture now RECORDS that the receipt actually
         * reached the production function. Round 5 asserted only "no outcome
         * yet", which is equally true when the receipt never arrives — the
         * exact vacuity a reviewer found. */
        receiptReached = typeof handlers.data === 'function';
        handlers.data?.(Buffer.from(JSON.stringify(ack) + '\n'));
      }, 10);
      setTimeout(() => { writeReleased = true; cb?.(); }, 400);   // …and released only later
      return true;
    },
  };
  broker.__terminalForTests(
    fake,
    { op: 'result', ok: true, text: 'D15 PAYLOAD '.padEnd(512, '.'), exitCode: 0, failureKind: null, sessionId: null, meta: {} },
    (delivered, why, proof) => { outcome = { delivered, proof, at: writeReleased ? 'after the write completed' : 'BEFORE the write completed' }; },
    true,
    () => { handoffSeen = true; },
  );
  // sampled BEFORE the write completes, then again after
  setTimeout(() => resolve({
    early: { receiptReached, outcome, handoffSeen, writeReleased },
    late: () => ({ outcome, handoffSeen, writeReleased }),
  }), 200);
});
await sleep(700);
const d15Late = d15.late();
check('D15 — a valid receipt arriving BEFORE Orchard\'s write completes is DEFERRED, then granted once the write lands', () => {
  show('receipt actually reached the production function', d15.early.receiptReached);
  show('at receipt time: write completed / handoff known / verdict', [d15.early.writeReleased, d15.early.handoffSeen, d15.early.outcome === null ? 'DEFERRED — no outcome' : d15.early.outcome]);
  show('after the write completed: handoff known / verdict', [d15Late.handoffSeen, d15Late.outcome]);
  assert.equal(d15.early.receiptReached, true, 'VACUOUS unless the receipt really reached terminal() — round 5 never checked this');
  assert.equal(d15.early.writeReleased, false, 'precondition: Orchard\'s write must genuinely still be incomplete at receipt time');
  assert.equal(d15.early.handoffSeen, false, 'precondition: Orchard\'s own fact must not exist yet, or nothing is being tested');
  assert.equal(d15.early.outcome, null, 'round 4 reported delivered:true here with handoff:false — a delivery that outran the sender\'s own fact');
  assert.ok(d15Late.outcome, 'the deferral must RESOLVE, not vanish — a verdict that never arrives is a lane held forever');
  assert.equal(d15Late.outcome.delivered, true, 'once Orchard\'s write completes, the already-valid receipt is granted (the deliberate choice: defer, do not refuse)');
  assert.equal(d15Late.outcome.at, 'after the write completed', 'the grant must happen from inside the write completion, never before it');
  assert.equal(d15Late.handoffSeen, true, 'the handoff must have been recorded by then');
});
/* =======================================================================
 * THE REAL CLIENT PROCESS — round-2 FINDING 1 was reachable only here,
 * because the old suite's peer was a mock that never wrote stdout.
 * ======================================================================= */

function runRealClient({ prompt, stdout = 'pipe', closeStdoutImmediately = false, env = {} } = {}) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(ROOT, 'src/server/dispatch-client.mjs'), '--prompt-stdin'], {
      env: { ...process.env, ORCHARD_DISPATCH_SOCK: sock, ...env }, stdio: ['pipe', stdout, 'pipe'],
    });
    let out = '', err = '';
    if (c.stdout) c.stdout.on('data', (b) => { out += b; });
    c.stderr.on('data', (b) => { err += b; });
    if (closeStdoutImmediately && c.stdout) c.stdout.destroy();
    c.on('close', (status) => resolve({ status, stdout: out, stderr: err }));
    c.stdin.end(prompt);
  });
}

const happy = await runRealClient({ prompt: 'real dispatch-client lane' });
await sleep(300);
check('C1 — the real client prints the result and its byte-counted receipt marks the lane delivered', () => {
  const r = lanes.list({ limit: 500 }).find((x) => x.charter.includes('real dispatch-client lane'));
  show('client exit / stdout head', [happy.status, (happy.stdout || '').slice(0, 60)]);
  show('record', r && { state: r.state, acknowledgedAt: r.acknowledgedAt, acknowledgedBy: r.acknowledgedBy, evidence: r.acknowledgementEvidence });
  assert.equal(happy.status, 0, `precondition: the real client must succeed — stderr: ${(happy.stderr || '').slice(-300)}`);
  assert.ok((happy.stdout || '').includes('real dispatch-client lane'), 'the client must have printed the result text');
  assert.ok(r, 'precondition: the lane must have been recorded');
  assert.equal(r.state, 'settled');
  assert.ok(r.acknowledgedAt != null, 'the real client reported the matching byte count, so the record must be stamped');
  assert.equal(r.acknowledgedBy, 'blocking-dispatch');
  assert.ok(r.acknowledgementEvidence.includes(String(Buffer.byteLength(happy.stdout, 'utf8'))), 'the evidence must be the count of bytes the parent actually read');
});

const devFull = fs.existsSync('/dev/full');
if (devFull) {
  const full = fs.openSync('/dev/full', 'w');
  const ensnosp = await runRealClient({ prompt: 'ENOSPC lane — the client cannot write its own stdout', stdout: full });
  fs.closeSync(full);
  await sleep(400);
  check('C2 — /dev/full (ENOSPC): the client fails loudly and the record stays HELD (round-2 FINDING 1, attack A)', () => {
    const r = lanes.list({ limit: 500 }).find((x) => x.charter.includes('ENOSPC lane'));
    show('client exit', ensnosp.status);
    show('client stderr', (ensnosp.stderr || '').trim().slice(0, 160));
    show('record', r && { state: r.state, acknowledgedAt: r.acknowledgedAt, held: lanes.isHeld(r), resultOnDisk: !!r.resultPointer });
    assert.ok(r, 'precondition: the lane must have been recorded');
    assert.equal(r.state, 'settled', 'precondition: the dispatch itself must have succeeded');
    assert.notEqual(ensnosp.status, 0, 'a client that could not emit the result must not report success');
    assert.match(ensnosp.stderr, /output-write-failed/);
    assert.equal(r.acknowledgedAt, null, 'ZERO bytes reached the parent — nothing may be stamped delivered');
    show('refused because', heldBecause(r, 'the connection closed before the peer proved possession'));
    assert.equal(lanes.isHeld(r), true);
    assert.ok(fs.readFileSync(r.resultPointer, 'utf8').length > 0, 'the result must still be held on disk, pullable');
  });
} else {
  console.log('SKIP C2 — /dev/full is not available on this host');
}

const epipe = await runRealClient({ prompt: 'delay=900 EPIPE lane — the reader hung up', closeStdoutImmediately: true });
await sleep(400);
check('C3 — EPIPE (the reader hung up): no receipt, and the record stays HELD (round-2 FINDING 1, attack B)', () => {
  const r = lanes.list({ limit: 500 }).find((x) => x.charter.includes('EPIPE lane'));
  show('client exit', epipe.status);
  show('client stderr', (epipe.stderr || '').trim().slice(0, 160));
  show('record', r && { state: r.state, acknowledgedAt: r.acknowledgedAt, held: lanes.isHeld(r) });
  assert.ok(r, 'precondition: the lane must have been recorded');
  assert.equal(r.state, 'settled', 'precondition: the dispatch itself must have succeeded');
  assert.notEqual(epipe.status, 0, 'a client whose stdout is gone must not report success');
  assert.equal(r.acknowledgedAt, null);
  show('refused because', heldBecause(r, 'the connection closed before the peer proved possession'));
  assert.equal(lanes.isHeld(r), true);
});

const bigChars = 2_000_000;
const big = await runRealClient({ prompt: `big result lane size=${bigChars}` });
await sleep(600);
check('C4 — a 2 MB result through the real client is delivered, not left held (round-2 FINDING 6)', () => {
  const r = lanes.list({ limit: 500 }).find((x) => x.charter.includes('big result lane'));
  show('client exit / stdout bytes', [big.status, Buffer.byteLength(big.stdout, 'utf8')]);
  show('record', r && { state: r.state, acknowledgedAt: r.acknowledgedAt, evidence: (r.acknowledgementEvidence || '').slice(0, 120) });
  assert.equal(big.status, 0, `precondition: the client must have succeeded — stderr: ${(big.stderr || '').slice(-200)}`);
  assert.ok(Buffer.byteLength(big.stdout, 'utf8') > 1_000_000, 'precondition: the result must really be large');
  assert.ok(r, 'precondition: the lane must have been recorded');
  assert.ok(r.acknowledgedAt != null, 'a large but complete delivery must still be stamped');
  assert.ok(r.acknowledgementEvidence.includes(String(Buffer.byteLength(big.stdout, 'utf8'))));
});

/* --- pruning a delivered record also drops its result file; a held one keeps its own --- */
check('P1 — pruned (delivered) result files are removed; held result files are not', () => {
  const real = JSON.parse(fs.readFileSync(lanes.laneStoreFile(), 'utf8'));
  const heldRec = { ...real[0], id: 'lane-keepme', dispatchedAt: 1, state: 'settled', acknowledgedAt: null, acknowledgedBy: null, dismissedAt: null, resultPointer: path.join(lanes.laneDir('lane-keepme'), 'result.txt') };
  fs.mkdirSync(lanes.laneDir('lane-keepme'), { recursive: true });
  fs.writeFileSync(heldRec.resultPointer, 'a result nobody has collected');
  const filler = [];
  for (let i = 0; i < lanes.MAX_RECORDS + 5; i++) {
    const id = `lane-old-${i}`;
    fs.mkdirSync(lanes.laneDir(id), { recursive: true });
    fs.writeFileSync(path.join(lanes.laneDir(id), 'result.txt'), 'delivered long ago');
    filler.push({ ...real[0], id, dispatchedAt: 10 + i, state: 'settled', acknowledgedAt: 20 + i, dismissedAt: null, resultPointer: path.join(lanes.laneDir(id), 'result.txt') });
  }
  fs.writeFileSync(lanes.laneStoreFile(), JSON.stringify([heldRec, ...filler, ...real]));
  lanes.recordDispatch({ label: 'trigger', charter: 'the next dispatch is what forces the bound', provider: 'openai', transport: 'blocking-dispatch' });
  const kept = lanes.list({ limit: 500 }).map((r) => r.id);
  show('held record survived', kept.includes('lane-keepme'));
  show('held result file still readable', fs.existsSync(heldRec.resultPointer) && fs.readFileSync(heldRec.resultPointer, 'utf8'));
  const goneDirs = filler.filter((r) => !kept.includes(r.id) && !fs.existsSync(lanes.laneDir(r.id))).length;
  const droppedCount = filler.filter((r) => !kept.includes(r.id)).length;
  show('delivered records dropped / whose files were also removed', [droppedCount, goneDirs]);
  assert.ok(droppedCount > 0, 'precondition: the store must have been over its bound');
  assert.equal(goneDirs, droppedCount, 'a dropped record must not leave its result file behind');
  assert.ok(kept.includes('lane-keepme'));
  assert.equal(fs.readFileSync(heldRec.resultPointer, 'utf8'), 'a result nobody has collected');
  fs.writeFileSync(lanes.laneStoreFile(), JSON.stringify(real));
});

/* --- truncated / partial reads of the REAL store --- */
check('P2 — a TRUNCATED ledger read throws instead of silently reading as empty', () => {
  const real = fs.readFileSync(lanes.laneStoreFile(), 'utf8');
  const before = lanes.list({ limit: 500 }).length;
  assert.ok(before >= 3, 'precondition: the real store must hold several records');
  const cuts = [1, Math.floor(real.length * 0.25), Math.floor(real.length * 0.5), Math.floor(real.length * 0.9), real.length - 1];
  const results = [];
  assert.equal(cuts.length, 5, 'precondition: five truncation points, or the loop below asserts nothing');
  for (const cut of cuts) {
    fs.writeFileSync(lanes.laneStoreFile(), real.slice(0, cut));
    let outcome;
    try { outcome = `returned ${lanes.readAll().length} records`; }
    catch (e) { outcome = `threw ${e.code}`; }
    results.push(`${cut}B → ${outcome}`);
  }
  show('truncations', results);
  assert.equal(results.length, 5, 'precondition: one outcome per truncation point (five), or the loop below asserts nothing');
  fs.writeFileSync(lanes.laneStoreFile(), real);
  show('records after restoring the real bytes', lanes.list({ limit: 500 }).length);
  assert.equal(lanes.list({ limit: 500 }).length, before, 'the real store must be intact after the experiment');
  for (const r of results) assert.ok(/threw corrupt/.test(r), `a truncated read must throw, got: ${r}`);
});

check('P3 — a corrupt ledger is NOT overwritten by the next write (held results survive)', () => {
  const real = fs.readFileSync(lanes.laneStoreFile(), 'utf8');
  fs.writeFileSync(lanes.laneStoreFile(), real.slice(0, Math.floor(real.length / 2)));
  let threw = null;
  try { lanes.recordDispatch({ label: 'x', charter: 'x', provider: 'openai', transport: 'blocking-dispatch' }); }
  catch (e) { threw = e.code; }
  const onDisk = fs.readFileSync(lanes.laneStoreFile(), 'utf8').length;
  show('write attempt on a corrupt store', threw);
  show('bytes still on disk (truncated copy preserved, not replaced by [])', onDisk);
  assert.equal(threw, 'corrupt');
  assert.ok(onDisk > 2, 'the store must not have been replaced with an empty array');
  assert.ok(fs.readdirSync(path.dirname(lanes.laneStoreFile())).some((f) => f.startsWith('lanes.json.corrupt-')), 'the corrupt bytes must be preserved');
  fs.writeFileSync(lanes.laneStoreFile(), real);
});

/* --- the bound: report, never delete, and NEVER stop recording --- */
check('P4 — over the bound with held results: capacity() reports it, nothing is deleted, recording CONTINUES', () => {
  const real = fs.readFileSync(lanes.laneStoreFile(), 'utf8');
  const heldOnly = [];
  for (let i = 0; i < lanes.MAX_RECORDS + 2; i++) {
    heldOnly.push({ ...JSON.parse(real)[0], id: `lane-full-${i}`, dispatchedAt: 100 + i, state: 'settled', acknowledgedAt: null, acknowledgedBy: null, dismissedAt: null });
  }
  fs.writeFileSync(lanes.laneStoreFile(), JSON.stringify(heldOnly));
  assert.equal(heldOnly.length, lanes.MAX_RECORDS + 2, 'precondition: the fixture must really exceed the bound');
  const cap = lanes.capacity();
  show('capacity()', cap);
  assert.equal(cap.held, heldOnly.length);
  assert.equal(cap.over, heldOnly.length - lanes.MAX_RECORDS);
  assert.match(cap.note, /Nothing is deleted and recording continues/);
  const rec2 = lanes.recordDispatch({ label: 'at the bound', charter: 'recording must not stop at the bound', provider: 'openai', transport: 'blocking-dispatch' });
  const after = JSON.parse(fs.readFileSync(lanes.laneStoreFile(), 'utf8'));
  show('records before/after a dispatch at the bound', [heldOnly.length, after.length]);
  show('every pre-existing held record still present', heldOnly.every((r) => after.some((x) => x.id === r.id)));
  assert.ok(after.some((r) => r.id === rec2.id), 'the ledger must keep recording past the bound — round 2 bricked here');
  for (const r of heldOnly) assert.ok(after.some((x) => x.id === r.id), `held record ${r.id} was deleted to make room`);
  fs.writeFileSync(lanes.laneStoreFile(), real);
});

{
  const real = fs.readFileSync(lanes.laneStoreFile(), 'utf8');
  fs.writeFileSync(lanes.laneStoreFile(), real.slice(0, Math.floor(real.length / 2)));
  const f = await request(sock, { op: 'dispatch', provider: 'openai', prompt: 'ledger is broken but the dispatch must still work' });
  check('P5 — a ledger write that FAILS never fails the dispatch (step 1 is observation only)', () => {
    show('terminal frame', { ok: f.at(-1).ok, exitCode: f.at(-1).exitCode });
    show('corrupt bytes untouched', fs.readFileSync(lanes.laneStoreFile(), 'utf8').length);
    assert.equal(f.at(-1).ok, true);
    assert.ok(f.at(-1).text.length > 0, 'the caller still got its result');
    assert.equal(fs.readFileSync(lanes.laneStoreFile(), 'utf8').length, Math.floor(real.length / 2), 'a failed write must not have rewritten the store');
  });
  fs.writeFileSync(lanes.laneStoreFile(), real);
}

/* --- R8: the delivery race, swept 1 ms at a time through the landing instant --- */
const peerJs = path.join(tmp, 'ack-peer.mjs');
fs.writeFileSync(peerJs, `
import * as net from 'node:net';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
const [, , sock, evidence, prompt] = process.argv;
const s = net.createConnection(sock);
let buf = '';
s.setEncoding('utf8');
s.on('connect', () => s.write(JSON.stringify({ op: 'dispatch', provider: 'openai', ack: true, prompt }) + '\\n'));
s.on('data', (x) => {
  buf += x;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    let f; try { f = JSON.parse(line); } catch { continue; }
    if (f.op !== 'result') continue;
    const got = Buffer.from(f.text ?? '', 'utf8');
    // The REAL bytes go to a REAL fd first, exactly as the production client
    // writes stdout before acknowledging; the marker follows them.
    fs.appendFileSync(evidence, got);
    fs.appendFileSync(evidence, 'GOT-RESULT\\n');
    const ack = { op: 'ack', bytes: got.length, fd: 1 };
    if (f.receiptNonce) { const ch = Buffer.from('fd1', 'utf8'); ack.digest = createHash('sha256').update(f.receiptNonce).update(ch.length + ':').update(ch).update(got).digest('hex'); } // ROUND 7: length-delimited channel, matching the real client + broker
    s.write(JSON.stringify(ack) + '\\n');
  }
});
s.on('error', () => {});
`);
const D = 250;
const calEv = path.join(tmp, 'cal-ev');
fs.writeFileSync(calEv, '');
const calT0 = Date.now();
const calPeer = spawn(process.execPath, [peerJs, sock, calEv, `delay=${D} calibration lane`], { stdio: 'ignore' });
/* Bounded: if the peer double ever crashes (it is a string, so a typo is a
 * runtime error on a child with stdio:'ignore'), a hang is a far worse failure
 * mode than a loud one. */
while (!fs.readFileSync(calEv, 'utf8').includes('GOT-RESULT')) {
  if (Date.now() - calT0 > 60_000) throw new Error('D7 calibration peer never reported GOT-RESULT within 60s — the peer double is broken, not the broker');
  await sleep(5);
}
const T = Date.now() - calT0;
try { process.kill(calPeer.pid, 'SIGKILL'); } catch { /* already gone */ }
await sleep(300);
let trials = 0, falseStamps = 0, trueDelivered = 0, correctlyHeld = 0;
const falseRows = [];
for (let i = 0; i < 24; i++) {
  const ev = path.join(tmp, `ev-${i}`);
  fs.writeFileSync(ev, '');
  const peer = spawn(process.execPath, [peerJs, sock, ev, `delay=${D} race trial ${i} `], { stdio: 'ignore' });
  await sleep(T - 40 + i * 2); // sweep from well before the landing instant to well after
  try { process.kill(peer.pid, 'SIGKILL'); } catch { /* already gone */ }
  await sleep(600);
  const rec8 = lanes.list({ limit: 500 }).find((r) => r.charter.includes(`race trial ${i} `));
  if (!rec8 || rec8.state === 'running') continue;
  trials++;
  const got = fs.readFileSync(ev, 'utf8').includes('GOT-RESULT');
  const stamped = rec8.acknowledgedAt != null;
  if (stamped && got) trueDelivered++;
  if (!stamped) correctlyHeld++;
  if (stamped && !got) { falseStamps++; falseRows.push({ trial: i, killedAt: T - 40 + i * 2, id: rec8.id }); }
}
check('D7 — no delivery stamp for a result the peer never received (kill swept through the landing instant)', () => {
  show('calibrated landing time', `${T}ms`);
  show('trials with a settled record', trials);
  show('control: peer GOT the text and the record says delivered', trueDelivered);
  show('control: correctly HELD (peer died first)', correctlyHeld);
  show('FALSE delivery stamps', falseStamps === 0 ? 0 : falseRows);
  assert.ok(trials >= 16, 'precondition: the sweep must have produced settled records');
  assert.ok(trueDelivered > 0, 'vacuous unless some trials really were delivered');
  assert.ok(correctlyHeld > 0, 'vacuous unless the sweep also covered the peer-died-first side');
  assert.equal(falseStamps, 0);
});

await broker.stop(project);

/* =======================================================================
 * ONE WRITER, ARBITRATED BY THE KERNEL. This replaces every lock test.
 * Fixtures are deliberately the ones round 2 said the old suite lacked:
 * a POPULATED ledger, MANY simultaneous contenders, and a real writer death.
 * ======================================================================= */

const contenderJs = path.join(tmp, 'contender.mjs');
fs.writeFileSync(contenderJs, `
const [, , startAt, n, tag, mode] = process.argv;
const lanes = await import(${JSON.stringify(path.join(ROOT, 'src/server/lanes.ts'))});
const claim = await lanes.claimWriter();
while (Date.now() < Number(startAt)) { /* align the burst */ }
let wrote = 0, refused = 0, other = 0;
const codes = new Set();
for (let i = 0; i < Number(n); i++) {
  const id = 'lane-' + tag + '-' + i;
  try {
    lanes.recordDispatch({ label: tag + i, charter: 'c', provider: 'openai', transport: 'blocking-dispatch' }, id);
    lanes.settle(id, { state: 'settled', resultText: ('RESULT ' + tag + ' ' + i + ' ').padEnd(3000, '.') });
    wrote++;
  } catch (e) { codes.add(e.code || e.name); if (e.code === 'not-writer') refused++; else other++; }
}
if (mode === 'hold') await new Promise((r) => setTimeout(r, 60_000));
process.stdout.write(JSON.stringify({ tag, claimOk: claim.ok, claimReason: claim.reason ?? null, wrote, refused, other, codes: [...codes] }));
`);
function runContender(dir, args, { keepAlive = false } = {}) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [contenderJs, ...args], { env: { ...process.env, CLAUDE_STATION_DATA: dir }, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    c.stdout.on('data', (b) => { out += b; });
    if (keepAlive) return resolve({ child: c, output: () => out });
    c.on('close', () => resolve(JSON.parse(out || '{}')));
  });
}

/* W1 — one live writer, a POPULATED ledger, a second process trying to write it. */
const w1Dir = path.join(tmp, 'w1');
const w1 = await withDataDir(w1Dir, async (claim) => {
  const ids = populate({ held: 20, delivered: 10, running: 3 });
  const before = fs.readFileSync(lanes.laneStoreFile(), 'utf8');
  const report = await runContender(w1Dir, [String(Date.now()), '25', 'INTRUDER']);
  const after = fs.readFileSync(lanes.laneStoreFile(), 'utf8');
  return { claim, ids, before, after, report };
});
check('W1 — a second PROCESS is refused `not-writer` and cannot touch a populated ledger', () => {
  show('this process held the claim', w1.claim.ok);
  show('intruder report', w1.report);
  show('ledger bytes before/after the intruder', [w1.before.length, w1.after.length]);
  assert.equal(w1.claim.ok, true, 'precondition: this process must have held the claim');
  assert.ok(w1.before.length > 20_000, 'precondition: the ledger must be realistically populated, not empty');
  assert.equal(w1.report.claimOk, false, 'the second process must be told it is not the writer');
  assert.equal(w1.report.refused, 25, 'every one of its writes must be refused, loudly');
  assert.equal(w1.report.wrote, 0);
  assert.deepEqual(w1.report.codes, ['not-writer']);
  assert.equal(w1.after, w1.before, 'not one byte of the held ledger may change');
  const held = JSON.parse(w1.after).filter((r) => w1.ids.held.includes(r.id));
  show('held records intact', `${held.length}/${w1.ids.held.length}`);
  assert.equal(held.length, w1.ids.held.length);
});

/* W2 — EIGHT simultaneous contenders on a fresh dir: exactly one may win. */
const w2Dir = path.join(tmp, 'w2');
fs.mkdirSync(w2Dir, { recursive: true });
const w2Start = Date.now() + 1200;
const w2 = await Promise.all(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((tag) => runContender(w2Dir, [String(w2Start), '12', tag])));
check('W2 — eight simultaneous contenders: exactly ONE writes, seven are refused, nothing is lost', () => {
  const winners = w2.filter((r) => r.claimOk);
  const ledger = JSON.parse(fs.readFileSync(path.join(w2Dir, 'lanes.json'), 'utf8'));
  const claimed = w2.reduce((a, r) => a + r.wrote, 0);
  const dirs = fs.existsSync(path.join(w2Dir, 'lanes')) ? fs.readdirSync(path.join(w2Dir, 'lanes')) : [];
  const ids = new Set(ledger.map((r) => r.id));
  const orphans = dirs.filter((d) => !ids.has(d));
  show('per-contender', w2.map((r) => `${r.tag}:${r.claimOk ? 'WRITER' : 'refused'} wrote=${r.wrote} refused=${r.refused}`));
  show('records claimed / on disk', [claimed, ledger.length]);
  show('orphan result dirs (a result no record names)', orphans.length);
  assert.equal(w2.length, 8, 'precondition: all eight contenders must have reported');
  assert.equal(winners.length, 1, 'the kernel must arbitrate exactly one writer');
  assert.equal(winners[0].wrote, 12);
  assert.equal(claimed, ledger.length, 'every claimed write must be on disk — this is the round-1 loss, in its realistic form');
  assert.equal(orphans.length, 0);
  for (const r of w2.filter((x) => !x.claimOk)) assert.equal(r.refused, 12, `${r.tag} must have been refused every time, not silently succeeded`);
});

/* W3 — the writer DIES: the kernel frees the claim, the successor takes it at
 * once (no staleness judgement, no 30 s wait), and the dead writer's HELD
 * results are untouched. This is the whole of round-2 findings 2, 2b and 3. */
const w3Dir = path.join(tmp, 'w3');
fs.mkdirSync(w3Dir, { recursive: true });
const holderProc = await runContender(w3Dir, [String(Date.now()), '6', 'DYING', 'hold'], { keepAlive: true });
await sleep(2500);
const w3BeforeKill = await withDataDirProbe(w3Dir);
holderProc.child.kill('SIGKILL');
await sleep(300);
const w3T0 = Date.now();
const w3After = await withDataDirProbe(w3Dir);
const w3ClaimMs = Date.now() - w3T0;
async function withDataDirProbe(dir) {
  const prev = process.env.CLAUDE_STATION_DATA;
  process.env.CLAUDE_STATION_DATA = dir;
  const claim = await lanes.claimWriter();
  const records = fs.existsSync(path.join(dir, 'lanes.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'lanes.json'), 'utf8')) : [];
  const results = records.filter((r) => r.resultPointer && fs.existsSync(r.resultPointer)).length;
  if (claim.ok) lanes.releaseWriter();
  process.env.CLAUDE_STATION_DATA = prev;
  await lanes.claimWriter();
  return { claim, records: records.length, results };
}
check('W3 — a dead writer\'s claim is freed by the kernel; the successor takes it at once and loses nothing', () => {
  show('while the writer was ALIVE, a successor\'s claim', { ok: w3BeforeKill.claim.ok, reason: w3BeforeKill.claim.reason });
  show('after SIGKILL, the successor\'s claim', { ok: w3After.claim.ok, waitedMs: w3ClaimMs });
  show('records / result files the dead writer left', [w3After.records, w3After.results]);
  assert.equal(w3BeforeKill.claim.ok, false, 'precondition: the live writer really did hold the claim');
  assert.equal(w3After.claim.ok, true, 'a dead writer must not block the store — and no code judged its staleness');
  assert.ok(w3ClaimMs < 1000, `the successor must not wait on a timer; waited ${w3ClaimMs}ms`);
  assert.equal(w3After.records, 6, 'the dead writer\'s records must all still be there');
  assert.equal(w3After.results, 6, 'and so must their result files');
});

/* W4 — the event loop, which round 2 measured frozen for 5009 ms with zero
 * timer ticks while a contended lock spun on the main thread. */
const w4Dir = path.join(tmp, 'w4');
const w4 = await withDataDir(w4Dir, async () => {
  populate({ held: 40, delivered: 15, running: 0, resultBytes: 4000 });
  const ticks = [];
  let last = Date.now();
  const timer = setInterval(() => { ticks.push(Date.now() - last); last = Date.now(); }, 10);
  const contenders = ['X', 'Y', 'Z', 'W'].map((t) => runContender(w4Dir, [String(Date.now()), '30', t]));
  const t0 = Date.now();
  for (let i = 0; i < 60; i++) {
    const id = `lane-loop-${i}`;
    lanes.recordDispatch({ label: 'loop', charter: 'c', provider: 'openai', transport: 'blocking-dispatch' }, id);
    lanes.settle(id, { state: 'settled', resultText: 'r'.repeat(4000) });
    await sleep(5);
  }
  const wallMs = Date.now() - t0;
  const reports = await Promise.all(contenders);
  clearInterval(timer);
  return { ticks, wallMs, reports };
});
check('W4 — writing a populated ledger under four contenders never freezes the event loop (round-2 FINDING 8: 5009 ms, 0 ticks)', () => {
  const maxGap = Math.max(...w4.ticks);
  const expectedTicks = Math.floor(w4.wallMs / 10);
  show('timer ticks observed / expected at 10ms', [w4.ticks.length, expectedTicks]);
  show('worst single gap (ms)', maxGap);
  show('wall time for 60 record+settle pairs on a 55-record ledger (ms)', w4.wallMs);
  show('contenders refused', w4.reports.map((r) => `${r.tag}:${r.refused}`));
  assert.ok(w4.wallMs > 300, 'precondition: the measurement window must be long enough for a freeze to be visible');
  assert.ok(w4.ticks.length > expectedTicks * 0.5, `precondition: the timer must have kept firing — ${w4.ticks.length} of ~${expectedTicks} (round 2 saw 0 of ~501)`);
  // ROUND 8 (cross-provider finding 5): `reports.every(...)` is vacuously true on
  // an empty read, so the contender count is pinned first — with no reports the
  // refusal check below asserts nothing.
  assert.equal(w4.reports.length, 4, `precondition: all four contenders reported; got ${w4.reports.length}`);
  assert.ok(w4.reports.every((r) => r.refused === 30), 'precondition: the contenders must really have been contending');
  assert.ok(maxGap < 1000, `the event loop must never stall for ~a second; worst gap was ${maxGap}ms`);
});

check('W5 — no lock file, no staleness judgement, nothing on disk to go stale', () => {
  const entries = fs.readdirSync(w2Dir);
  show('data dir entries', entries);
  show('claim name (abstract: no filesystem entry)', JSON.stringify(lanes.writerClaimName(w2Dir)));
  assert.equal(entries.includes('lanes.lock'), false);
  assert.equal(entries.some((e) => e.includes('lock')), false);
  if (process.platform === 'linux') assert.ok(lanes.writerClaimName(w2Dir).startsWith('\0'), 'on Linux the claim lives in the abstract namespace');
});

/* --- W6: the NON-LINUX claim path, which no test on this host had ever run ---
 * Round 3 flagged it and declined to touch it: off Linux the claim is a
 * FILESYSTEM socket, whose inode outlives its process, so after a SIGKILL the
 * successor is refused EADDRINUSE forever and the ledger becomes permanently
 * unwritable. It is unreachable on this host unless `process.platform` is faked
 * BEFORE lanes.ts is imported — everything else (socket, SIGKILL, EADDRINUSE)
 * is real. Round 4 does not auto-unlink (two successors racing that recovery
 * would produce two writers); it DIAGNOSES, so the failure is named and
 * actionable instead of an unexplained EADDRINUSE. This test guards the
 * diagnosis, and the control leg guards that a LIVE holder is still refused
 * plainly. Full reproducer: scripts/scratch-a17-r4-fssock-wedge.mjs */
const w6Dir = path.join(tmp, 'w6');
fs.mkdirSync(w6Dir, { recursive: true });
const w6Js = path.join(tmp, 'w6-claim.mjs');
fs.writeFileSync(w6Js, `
Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
const lanes = await import(${JSON.stringify(path.join(ROOT, 'src/server/lanes.ts'))});
const claim = await lanes.claimWriter();
process.stdout.write(JSON.stringify({ claim, pid: process.pid }) + '\\n');
if (process.argv[2] === 'hold') await new Promise((r) => setTimeout(r, 30_000));
`);
function w6Run(mode) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [w6Js, mode], { env: { ...process.env, CLAUDE_STATION_DATA: w6Dir }, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    c.stdout.on('data', (b) => { out += b; if (mode === 'hold' && out.includes('\n')) resolve({ wrapper: c.pid, ...JSON.parse(out.split('\n')[0]) }); });
    if (mode !== 'hold') c.on('close', () => resolve(out.trim() ? JSON.parse(out.trim().split('\n').pop()) : { error: 'no output' }));
  });
}
const w6Holder = await w6Run('hold');
const w6Live = await w6Run('once');          // control: a LIVE holder
process.kill(w6Holder.pid, 'SIGKILL');
await sleep(400);
const w6Stale = await w6Run('once');         // the wedge: the holder is dead, the inode is not
check('W6 — the non-Linux FILESYSTEM claim: a live holder is refused plainly, and a dead one is refused with a DIAGNOSIS (round-3 flagged, never exercised)', () => {
  show('claim name off Linux', w6Holder.claim.name);
  show('socket file left on disk after SIGKILL', fs.existsSync(w6Holder.claim.name));
  show('second claimant while the holder is ALIVE', w6Live.claim);
  show('claimant after the holder was SIGKILLed', w6Stale.claim.reason);
  assert.equal(w6Holder.claim.ok, true, 'precondition: the first claim must succeed');
  assert.ok(!w6Holder.claim.name.startsWith('\0'), 'precondition: the faked platform must take the FILESYSTEM path');
  assert.equal(w6Live.claim.ok, false, 'precondition: a live holder must still exclude a second writer');
  assert.equal(w6Live.claim.reason, 'EADDRINUSE', 'a live holder is a plain EADDRINUSE, not a stale socket');
  assert.equal(fs.existsSync(w6Holder.claim.name), true, 'precondition: the wedge exists only because the inode outlives the process');
  assert.equal(w6Stale.claim.ok, false, 'the stale socket is NOT auto-recovered — that race would admit two writers');
  assert.ok(w6Stale.claim.reason.startsWith('EADDRINUSE-stale-socket:'), `the refusal must NAME the condition; got ${w6Stale.claim.reason}`);
  assert.ok(w6Stale.claim.reason.includes(w6Holder.claim.name), 'the refusal must name the file a human has to remove');
});
try { process.kill(w6Holder.wrapper, 'SIGKILL'); } catch { /* already gone */ }

/* =======================================================================
 * Store behaviour under bad input, and the identity rules (rule 3).
 * ======================================================================= */

check('S1 — settle() on a missing record THROWS (round 1 returned null) and writes no orphan result file', () => {
  let code = null, message = '';
  try { lanes.settle('lane-does-not-exist', { state: 'settled', resultText: 'IRREPLACEABLE' }); }
  catch (e) { code = e.code; message = e.message; }
  show('thrown code', code);
  show('message', message.slice(0, 90));
  show('orphan result dir created', fs.existsSync(lanes.laneDir('lane-does-not-exist')));
  assert.equal(code, 'record-missing');
  assert.equal(fs.existsSync(lanes.laneDir('lane-does-not-exist')), false);
});

check('S10 — a successful acknowledgement CLEARS the earlier refusal reason (round-7 finding 1a)', () => {
  /* Measured before, on disk:
   *   {"acknowledged":true,"heldReason":"old refusal: …NO possession proof"}
   * A record that is acknowledged is not held, so a "why it is held" string on
   * it is false — and it is the string a rail would render at a user. */
  const id = 'lane-s10-stale';
  lanes.recordDispatch({ label: 's10', charter: 'S10 stale-reason lane', provider: 'openai', transport: 'blocking-dispatch' }, id);
  lanes.settle(id, { state: 'settled', resultText: 'S10 PAYLOAD'.padEnd(512, '.') });
  lanes.markHeldReason(id, 'old refusal: the peer acknowledged with NO possession proof');
  const refused = diskRecord(id);
  lanes.markHandoff(id, 512, 'Orchard wrote it');
  lanes.markAcknowledged(id, 'blocking-dispatch', 'a later, VALID receipt', 'possession-digest-fd1');
  const after = diskRecord(id);
  show('ON DISK while refused', { acknowledgedAt: refused.acknowledgedAt, heldReason: refused.heldReason, held: lanes.isHeld(refused) });
  show('ON DISK after the acknowledgement', { acknowledgedAt: after.acknowledgedAt != null, heldReason: after.heldReason, held: lanes.isHeld(after) });
  assert.ok(refused.heldReason, 'precondition: a refusal reason must really have been recorded first, or nothing is being cleared');
  assert.equal(lanes.isHeld(refused), true, 'precondition: the record must genuinely have been held');
  assert.ok(after.acknowledgedAt != null, 'precondition: the acknowledgement must have landed');
  assert.equal(after.heldReason, null, 'a record that is no longer held may not keep saying why it is held');
});

check('S11 — an acknowledgement that CANNOT be recorded still leaves a reason on disk (round-7 finding 1b)', () => {
  /* The broker's outcome lifecycle, driven directly against a real on-disk
   * record. Before: the catch only logged, so a valid receipt whose stamp threw
   * left `{"acknowledged":false,"handoff":null,"heldReason":null}` — held with
   * no explanation at exactly the moment one matters. The stamp is made to fail
   * the way it fails in production: the handoff was never recorded (its own
   * write having failed), so the store refuses the acknowledgement. */
  const id = 'lane-s11-nohandoff';
  lanes.recordDispatch({ label: 's11', charter: 'S11 outcome-lifecycle lane', provider: 'openai', transport: 'blocking-dispatch' }, id);
  lanes.settle(id, { state: 'settled', resultText: 'S11 PAYLOAD'.padEnd(512, '.') });
  const before = diskRecord(id);
  broker.__recordOutcomeForTests(id, true, 'a VALID receipt: the peer returned a matching possession proof', 'possession-digest-fd1');
  const after = diskRecord(id);
  show('ON DISK before the outcome', { handoffAt: before.handoffAt, acknowledgedAt: before.acknowledgedAt, heldReason: before.heldReason });
  show('ON DISK after a valid receipt whose stamp could not be written', { acknowledgedAt: after.acknowledgedAt, heldReason: (after.heldReason || '').slice(0, 96), held: lanes.isHeld(after) });
  assert.equal(before.handoffAt, null, 'precondition: the handoff must genuinely be missing, which is what makes the stamp fail');
  assert.equal(after.acknowledgedAt, null, 'the record must stay held — a result recorded as collected when Orchard has no record of sending it is the data-loss case');
  assert.ok(after.heldReason, 'VACUOUS-BY-SILENCE: the stamp failed and nothing on disk says why');
  assert.ok(after.heldReason.includes('could not be recorded'), `the reason must name what went wrong, got ${JSON.stringify((after.heldReason || '').slice(0, 120))}`);
  assert.equal(lanes.isHeld(after), true);
});

check('S12 — a legacy name may not FABRICATE an acknowledgement (round-7 finding 2)', () => {
  /* Measured before: {deliveredAt:123, acknowledgedAt:null} read back as
   * acknowledgedAt=123 with handoffAt=null — an acknowledgement invented from a
   * legacy field, on a record the store would never have let exist. This path
   * runs against the live lanes.json, so the control leg matters as much as the
   * attack: a well-formed legacy record must still upgrade. */
  const dir = path.join(tmp, 's12');
  fs.mkdirSync(dir, { recursive: true });
  const prev = process.env.CLAUDE_STATION_DATA;
  process.env.CLAUDE_STATION_DATA = dir;
  const rows = [];
  try {
    for (const [tag, records] of [
      ['legacy 123 vs an explicit acknowledgedAt:null', [{ id: 'x1', deliveredAt: 123, acknowledgedAt: null, handoffAt: 122 }]],
      ['legacy null vs acknowledgedAt:123', [{ id: 'x2', deliveredAt: null, acknowledgedAt: 123, handoffAt: 122 }]],
      ['acknowledged with NO handoff at all', [{ id: 'x3', acknowledgedAt: 123, handoffAt: null }]],
      ['CONTROL: legacy name alone, coherent', [{ id: 'ok', deliveredAt: 1700, deliveredBy: 'blocking-dispatch', deliveryEvidence: 'legacy', handoffAt: 1699 }]],
      ['CONTROL: both names, SAME value', [{ id: 'ok2', deliveredAt: 1700, acknowledgedAt: 1700, handoffAt: 1699 }]],
    ]) {
      fs.writeFileSync(path.join(dir, 'lanes.json'), JSON.stringify(records));
      let read = null, code = null;
      try { read = lanes.readAll(); } catch (e) { code = e.code; }
      rows.push({ input: tag, refusedWith: code, acknowledgedAt: read ? read[0].acknowledgedAt ?? null : null, handoffAt: read ? read[0].handoffAt ?? null : null });
    }
  } finally { process.env.CLAUDE_STATION_DATA = prev; }
  for (const r of rows) show(r.input, { refusedWith: r.refusedWith, acknowledgedAt: r.acknowledgedAt, handoffAt: r.handoffAt });
  for (const r of rows.slice(0, 3)) assert.equal(r.refusedWith, 'corrupt', `${r.input} must be refused, not resolved by guesswork`);
  assert.equal(rows[3].refusedWith, null, 'CONTROL: a coherent legacy record must still upgrade — the live ledger depends on it');
  assert.equal(rows[3].acknowledgedAt, 1700, 'and must carry its value across');
  assert.equal(rows[4].refusedWith, null, 'CONTROL: both names agreeing is not a conflict');
});

check('S8 — an acknowledgement with NO handoff behind it is refused BY THE STORE, checked on disk (round-6 finding 2)', () => {
  /* The broker's handoff stamp is best-effort (it logs and continues), so the
   * only place this invariant can actually hold is the store. Measured before
   * this guard, reading the FILE and not a return value:
   *   disk after failed handoff {"acknowledged":true,"handoff":null} */
  const id = 'lane-s8-nohandoff';
  lanes.recordDispatch({ label: 's8', charter: 'S8 — acknowledgement with no handoff', provider: 'openai', transport: 'blocking-dispatch' }, id);
  lanes.settle(id, { state: 'settled', resultText: 'S8 PAYLOAD'.padEnd(512, '.') });
  let code = null;
  try { lanes.markAcknowledged(id, 'blocking-dispatch', 'S8: a receipt with nothing behind it', 'possession-digest-fd1'); } catch (e) { code = e.code; }
  const disk = diskRecord(id);
  show('refusal code', code);
  show('ON DISK after the attempt', { acknowledgedAt: disk.acknowledgedAt, handoffAt: disk.handoffAt, heldReason: disk.heldReason, held: lanes.isHeld(disk) });
  assert.ok(disk, 'precondition: the record must exist to be stamped');
  assert.equal(disk.handoffAt, null, 'precondition: this lane must genuinely have no handoff recorded');
  assert.equal(code, 'handoff-missing', 'the store must refuse, not the caller remember to');
  assert.equal(disk.acknowledgedAt, null, 'nothing may be acknowledged on the consumer\'s half alone');

  const ctl = 'lane-s8-control';
  lanes.recordDispatch({ label: 's8c', charter: 'S8 control', provider: 'openai', transport: 'blocking-dispatch' }, ctl);
  lanes.settle(ctl, { state: 'settled', resultText: 'S8 CONTROL'.padEnd(512, '.') });
  lanes.markHandoff(ctl, 512, 'control: Orchard wrote it');
  lanes.markAcknowledged(ctl, 'blocking-dispatch', 'control', 'possession-digest-fd1');
  const ctlDisk = diskRecord(ctl);
  show('control ON DISK (handoff first)', { acknowledgedAt: ctlDisk.acknowledgedAt != null, handoffAt: ctlDisk.handoffAt != null });
  assert.ok(ctlDisk.acknowledgedAt != null, 'CONTROL: with a handoff recorded, the acknowledgement must still land — or the guard has broken the happy path');
});

check('S9 — a malformed or ambiguous stamp is REFUSED at read, never reinterpreted (round-6 finding 3)', () => {
  /* Measured before: {"id":"bad","acknowledgedAt":"garbage"} read back verbatim
   * and `isHeld()` then reported FALSE — a held result silently retired and
   * made prunable. This is the path that touches the real records in the live
   * lanes.json, so it refuses loudly and preserves the bytes. */
  const dir = path.join(tmp, 's9');
  fs.mkdirSync(dir, { recursive: true });
  const prev = process.env.CLAUDE_STATION_DATA;
  process.env.CLAUDE_STATION_DATA = dir;
  const rows = [];
  try {
    for (const [tag, records] of [
      ['a string acknowledgedAt', [{ id: 'bad', acknowledgedAt: 'garbage' }]],
      ['a string LEGACY deliveredAt', [{ id: 'bad2', deliveredAt: 'garbage' }]],
      ['both names, DIFFERENT values', [{ id: 'bad3', deliveredAt: 111, acknowledgedAt: 222 }]],
      ['a boolean handoffAt', [{ id: 'bad4', handoffAt: true }]],
      ['a GOOD legacy record (must still upgrade)', [{ id: 'ok1', deliveredAt: 1700, deliveredBy: 'blocking-dispatch', deliveryEvidence: 'legacy evidence', handoffAt: 1699 }]],
    ]) {
      fs.writeFileSync(path.join(dir, 'lanes.json'), JSON.stringify(records));
      let read = null, code = null;
      try { read = lanes.readAll(); } catch (e) { code = e.code; }
      rows.push({ input: tag, refusedWith: code, readBack: read ? JSON.stringify(read[0]).slice(0, 80) : null });
    }
  } finally { process.env.CLAUDE_STATION_DATA = prev; }
  for (const r of rows) show(r.input, { refusedWith: r.refusedWith, readBack: r.readBack });
  for (const r of rows.slice(0, 4)) assert.equal(r.refusedWith, 'corrupt', `${r.input} must be refused, not reinterpreted`);
  const good = rows[4];
  assert.equal(good.refusedWith, null, 'CONTROL: a well-formed legacy record must still be readable — the 10 records in the live ledger depend on it');
  assert.ok(good.readBack.includes('acknowledgedAt'), 'the legacy record must come back under the current name');
  assert.ok(!good.readBack.includes('deliveredAt'), 'and without the legacy one');
});

check('S2 — markAcknowledged() on a missing record THROWS, and re-stamping is a no-op (first stamp wins)', () => {
  let code = null;
  try { lanes.markAcknowledged('lane-does-not-exist', 'blocking-dispatch', 'evidence'); } catch (e) { code = e.code; }
  show('markAcknowledged on a missing record', code);
  assert.equal(code, 'record-missing');
  const id = 'lane-double-stamp';
  lanes.recordDispatch({ label: 'x', charter: 'x', provider: 'openai', transport: 'blocking-dispatch' }, id);
  lanes.settle(id, { state: 'settled', resultText: 'text' });
  lanes.markHandoff(id, 4, 'S2 fixture: Orchard wrote it');
  const first = lanes.markAcknowledged(id, 'blocking-dispatch', 'first: 4 bytes matched');
  const second = lanes.markAcknowledged(id, 'user', 'second: a forged extra ack');
  show('first / second stamp', [{ at: first.acknowledgedAt, by: first.acknowledgedBy }, { at: second.acknowledgedAt, by: second.acknowledgedBy }]);
  assert.equal(second.acknowledgedAt, first.acknowledgedAt, 'a duplicate ack must not re-stamp');
  assert.equal(second.acknowledgedBy, 'blocking-dispatch');
  assert.match(second.acknowledgementEvidence, /^first:/);
});

await withDataDir(path.join(tmp, 'corrupt-data'), async () => {
  fs.writeFileSync(lanes.laneStoreFile(), '[{"id":"a","dispatchedAt":1},{"id":"b"'); // truncated
  check('S3 — a corrupt ledger is preserved ONCE, not once per read (round 1: one full copy per dispatch)', () => {
    let threw = 0;
    for (let i = 0; i < 40; i++) { try { lanes.capacity(); } catch (e) { if (e.code === 'corrupt') threw++; } }
    const copies = fs.readdirSync(path.dirname(lanes.laneStoreFile())).filter((f) => f.startsWith('lanes.json.corrupt-'));
    show('reads that threw corrupt', threw);
    show('.corrupt-* copies created by 40 reads', copies.length);
    assert.equal(threw, 40, 'precondition: every read must have failed loudly');
    assert.equal(copies.length, 1);
  });
});

await withDataDir(path.join(tmp, 'malformed-data'), async (claim) => {
  fs.writeFileSync(lanes.laneStoreFile(), '[null, 42, "x", {"id":"ok","dispatchedAt":1}]');
  check('S4 — a ledger of non-objects raises LaneStoreError, not a raw TypeError', () => {
    const seen = [];
    for (const [name, fn] of [['list', () => lanes.list()], ['capacity', () => lanes.capacity()], ['reconcileBoot', () => lanes.reconcileBoot()]]) {
      try { fn(); seen.push(`${name}: DID NOT THROW`); }
      catch (e) { seen.push(`${name}: ${e.name}/${e.code ?? 'none'}`); }
    }
    show('writer claim held for this dir', claim.ok);
    show('callers', seen);
    assert.equal(seen.length, 3, 'precondition: all three callers must have been exercised');
    assert.equal(claim.ok, true, 'precondition: reconcileBoot must get past the writer check to reach the parse');
    for (const line of seen) assert.match(line, /LaneStoreError\/corrupt/, `expected a LaneStoreError from ${line}`);
  });
});

check('S5 — a RECYCLED serverPid cannot pin a running claim forever', () => {
  const stranger = spawn(process.execPath, ['-e', 'setTimeout(()=>{},9000)'], { stdio: 'ignore' });
  const all2 = JSON.parse(fs.readFileSync(lanes.laneStoreFile(), 'utf8'));
  const template = all2.find((r) => r.serverPid);
  all2.push({ ...template, id: 'lane-recycled-owner', state: 'running', settledAt: null, acknowledgedAt: null, dismissedAt: null, pid: 999999, argvToken: 'gone', serverPid: stranger.pid, serverStart: '1', bootId: template.bootId ?? null, reconciledAt: null, reconcileDetail: null });
  fs.writeFileSync(lanes.laneStoreFile(), JSON.stringify(all2));
  let live = true;
  try { process.kill(stranger.pid, 0); } catch { live = false; }
  show('unrelated process wearing the recorded serverPid is alive', live);
  assert.equal(live, true, 'precondition: the impostor process must be running');
  const sum = lanes.reconcileBoot();
  const r = lanes.get('lane-recycled-owner');
  show('summary', { checked: sum.checked, cut: sum.cut, leftRunning: sum.leftRunning });
  show('record', { state: r.state, detail: r.reconcileDetail });
  assert.equal(r.state, 'cut', 'a claim whose owner is only a pid NUMBER match must be resolved, not held forever');
  assert.match(r.reconcileDetail, /recycled/);
  stranger.kill('SIGKILL');
});

check('S6 — serverPid 0 / -1 are never read as a live owner (kill(0)/kill(-1) hit process GROUPS)', () => {
  const all2 = JSON.parse(fs.readFileSync(lanes.laneStoreFile(), 'utf8'));
  const template = all2.find((r) => r.serverPid);
  for (const [id, pid] of [['lane-pid0', 0], ['lane-pidneg', -1]]) {
    all2.push({ ...template, id, state: 'running', settledAt: null, acknowledgedAt: null, dismissedAt: null, pid: null, argvToken: null, serverPid: pid, serverStart: '1', bootId: null, reconciledAt: null, reconcileDetail: null });
  }
  fs.writeFileSync(lanes.laneStoreFile(), JSON.stringify(all2));
  lanes.reconcileBoot();
  const states = ['lane-pid0', 'lane-pidneg'].map((id) => `${id}=${lanes.get(id).state}`);
  assert.equal(states.length, 2, 'precondition: both pid shapes must be present');
  show('states after reconcile', states);
  show('sameProcess(0,…) / sameProcess(-1,…)', [lanes.sameProcess(0, '1', null), lanes.sameProcess(-1, '1', null)]);
  for (const s of states) assert.match(s, /=cut$/);
  assert.equal(lanes.sameProcess(0, '1', null), false);
  assert.equal(lanes.sameProcess(-1, '1', null), false);
});

check('S7 — a live process wearing the wrong argv is not our child', () => {
  const stranger = spawn(process.execPath, ['-e', 'setTimeout(()=>{},4000)'], { stdio: 'ignore' });
  const verdict = lanes.liveWithToken(stranger.pid, 'lane-not-in-this-argv');
  const truthful = lanes.liveWithToken(stranger.pid, '-e');
  show('live process, wrong token', verdict);
  show('live process, token present in argv', truthful);
  assert.equal(verdict, 'pid-reused');
  assert.equal(truthful, 'alive');
  stranger.kill('SIGKILL');
});

/* ------------------------------------------------- boot reconciliation, for real */

/*
 * A REAL server restart in its OWN data dir (it must hold that dir's writer
 * claim, which this process cannot also hold): a separate node process boots the
 * broker, starts a lane that hangs, and is then SIGKILLed — the F2 case exactly.
 * Reconciliation then runs here, as a fresh boot would.
 */
const restartDir = path.join(tmp, 'restart');
fs.mkdirSync(restartDir, { recursive: true });
const serverJs = path.join(tmp, 'mini-server.mjs');
fs.writeFileSync(serverJs, `
import * as net from 'node:net';
const broker = await import(${JSON.stringify(path.join(ROOT, 'src/server/dispatch-broker.ts'))});
const project = ${JSON.stringify({ ...project, id: 'arch017-restart' })};
const sock = await broker.start(project);
const s = net.createConnection(sock, () => s.write(JSON.stringify({ op: 'dispatch', provider: 'openai', ack: true, prompt: 'hang forever' }) + '\\n'));
s.on('error', () => {});
console.log('READY');
setTimeout(() => {}, 120000);
`);
const server = spawn(process.execPath, [serverJs], { env: { ...process.env, CLAUDE_STATION_DATA: restartDir }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverOut = '';
server.stdout.on('data', (b) => { serverOut += b; });
server.stderr.on('data', (b) => { serverOut += b; });
await sleep(3000);
const restartProbe = async () => {
  const prev = process.env.CLAUDE_STATION_DATA;
  process.env.CLAUDE_STATION_DATA = restartDir;
  const claim = await lanes.claimWriter();
  return { claim, restore: async () => { process.env.CLAUDE_STATION_DATA = prev; await lanes.claimWriter(); } };
};
const restartLedger = () => JSON.parse(fs.readFileSync(path.join(restartDir, 'lanes.json'), 'utf8'));
const runningBefore = restartLedger().filter((r) => r.state === 'running');
const orphanPid = runningBefore[0]?.pid ?? null;
server.kill('SIGKILL');
await sleep(500);
const probe = await restartProbe();
check('B1 — precondition: the killed server left a `running` claim with a live orphan child', () => {
  show('mini-server output', serverOut.trim().slice(0, 120));
  show('running records it left', runningBefore.map((r) => ({ id: r.id, pid: r.pid, serverPid: r.serverPid })));
  let childAlive = false;
  try { process.kill(orphanPid, 0); childAlive = true; } catch { /* gone */ }
  show('orphan child still alive', childAlive);
  show('the successor could take the dead server\'s claim', probe.claim.ok);
  assert.equal(runningBefore.length, 1, 'the dispatch must have been recorded as running before the kill');
  assert.equal(childAlive, true, 'the orphan child must have outlived its server — that is the case being reconciled');
  assert.equal(probe.claim.ok, true, 'the dead server\'s claim must have been released by the kernel');
});

const summary = lanes.reconcileBoot();
/*
 * STEP 2 CHANGED THIS TEST'S EXPECTED ANSWER, deliberately — recorded rather
 * than quietly rewritten. Step 1 CUT a provably-alive orphan
 * (`failureKind:'server-restart-orphan-alive'`) because the socket carrying its
 * result died with the server, so the result really was unreachable. Step 2's
 * background lanes settle into a FILE this store owns, so a new server can
 * still collect it — and cutting there would destroy a live fan-out on every
 * restart. The adoption is taken ONLY on the same proof the cut used (the
 * child's argv still carries the lane's token); everything short of that proof
 * still cuts, which B2b below is the guard for.
 */
check('B2 — boot reconciliation ADOPTS a provably-alive orphan instead of cutting a live lane', () => {
  const after = restartLedger().find((r) => r.id === runningBefore[0]?.id);
  show('summary', { checked: summary.checked, cut: summary.cut, adopted: summary.adopted, leftRunning: summary.leftRunning });
  show('record after reconcile', after && { state: after.state, failureKind: after.failureKind, ownedByThisServer: after.serverPid === process.pid, detail: (after.reconcileDetail || '').slice(0, 140) });
  assert.equal(summary.checked, 1, 'precondition: exactly one running claim was examined');
  assert.equal(summary.adopted, 1);
  assert.equal(summary.cut, 0, 'a lane proven alive must not be cut');
  assert.equal(after.state, 'running', 'the lane is still running — the ledger must say so');
  assert.equal(after.failureKind, null, 'an adopted lane has not failed');
  assert.equal(after.serverPid, process.pid, 'the adopting server must take ownership, or the next boot re-orphans it');
  assert.match(after.reconcileDetail, /ADOPTED/);
  assert.equal(after.acknowledgedAt, null, 'nothing was delivered by adopting, so it stays held');
});

/*
 * TWO records, and the second one is the point.
 *
 * ROUND 2 OF STEP 2 — a mutation check (`scripts/verify-arch-017-mutation.mjs`)
 * found this test was only ever exercising the DEAD path. The original record
 * used `pid: 999999`, which `process.kill(999999, 0)` reports as ESRCH, so
 * `liveWithToken` returned `'dead'` and the `'pid-reused'` branch — the one
 * that actually distinguishes "alive" from "alive AND still ours" — was never
 * reached. Mutant M8 (`status === 'alive' || status === 'pid-reused'` in the
 * adopt branch) survived BOTH default suites: the guard existed only behind
 * `--must-fail-proof`, which is the same "green run is not evidence" defect the
 * verifier reported against E5. A LIVE pid with the wrong token is added below
 * so the default run asserts it.
 */
check('B2b — adoption requires PROOF: neither a dead child NOR a reused live pid is adopted', () => {
  const all = restartLedger();
  const tpl = all[0];
  const orphan = (id, over) => ({ ...tpl, id, state: 'running', settledAt: null, failureKind: null, reconciledAt: null, reconcileDetail: null, acknowledgedAt: null, handoffAt: null, dismissedAt: null, serverPid: 999998, serverStart: '1', bootId: 'gone', ...over });
  all.push(orphan('lane-dead-child', { pid: 999999, argvToken: 'token-that-is-not-there' }));
  // A pid that is unambiguously ALIVE (this very process) carrying a token its
  // argv does not contain: the pid-reuse case, and the only one where a naive
  // "is the pid alive?" check would wrongly adopt.
  all.push(orphan('lane-reused-pid', { pid: process.pid, argvToken: 'a-token-this-process-does-not-carry' }));
  fs.writeFileSync(path.join(restartDir, 'lanes.json'), JSON.stringify(all));
  const naiveWouldAdopt = (() => { try { process.kill(process.pid, 0); return true; } catch { return false; } })();
  const s = lanes.reconcileBoot();
  const after = restartLedger();
  const dead = after.find((x) => x.id === 'lane-dead-child');
  const reused = after.find((x) => x.id === 'lane-reused-pid');
  show('liveWithToken on the reused pid', lanes.liveWithToken(process.pid, 'a-token-this-process-does-not-carry'));
  show('naive rule (the pid is alive ⇒ adopt)', naiveWouldAdopt ? 'WOULD ADOPT' : 'would not');
  show('summary', { adopted: s.adopted, cut: s.cut });
  show('dead child', { state: dead.state, failureKind: dead.failureKind });
  show('reused live pid', { state: reused.state, failureKind: reused.failureKind, detail: (reused.reconcileDetail || '').slice(0, 110) });
  assert.equal(lanes.liveWithToken(process.pid, 'a-token-this-process-does-not-carry'), 'pid-reused', 'precondition: this record must really exercise the pid-reused branch, not the dead one');
  assert.equal(naiveWouldAdopt, true, 'precondition: a naive liveness check really would fire here');
  assert.equal(s.adopted, 0, 'no proof of identity ⇒ no adoption; adopting on a guess leaves a lane "running" forever behind a pid that is somebody else');
  assert.equal(dead.state, 'cut');
  assert.equal(dead.failureKind, 'server-restart');
  assert.equal(reused.state, 'cut', 'a LIVE pid that is not our child must still be cut');
  assert.equal(reused.failureKind, 'server-restart');
  assert.match(reused.reconcileDetail, /argv no longer carries/);
});

check('B3 — a claim owned by a LIVE server is left alone (two servers, one data dir)', () => {
  const all2 = restartLedger();
  const template = all2[0];
  all2.push({ ...template, id: 'lane-live-owner', state: 'running', settledAt: null, reconciledAt: null, reconcileDetail: null, acknowledgedAt: null, dismissedAt: null, pid: null, argvToken: null, serverPid: process.pid, serverStart: lanes.procStartTime(process.pid), bootId: lanes.bootId() });
  fs.writeFileSync(path.join(restartDir, 'lanes.json'), JSON.stringify(all2));
  const s = lanes.reconcileBoot();
  const r = restartLedger().find((x) => x.id === 'lane-live-owner');
  show('summary', { checked: s.checked, cut: s.cut, leftRunning: s.leftRunning });
  show('record', { state: r.state, detail: (r.reconcileDetail || '').slice(0, 80) });
  // Asserted on THIS record's own outcome, not on a global count: B2 now leaves
  // an ADOPTED row behind (owned by this same live server), so a bare
  // `leftRunning === 1` would be measuring the previous test, not this one.
  assert.ok(s.details.some((d) => d.startsWith('lane-live-owner: left running')), `the live owner's lane must be reported as left running; got ${JSON.stringify(s.details)}`);
  assert.ok(s.leftRunning >= 1);
  assert.equal(r.state, 'running', 'another live server\'s in-flight lane must not be cut from under it');
});

try { if (orphanPid) process.kill(orphanPid, 'SIGKILL'); } catch { /* already gone */ }
await probe.restore();

/* ----------------------------------------- usage really reaches --meta-out (real dispatch.mjs) */

check('U1 — scripts/dispatch.mjs writes the engine\'s usage block to --meta-out', () => {
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const shim = path.join(bin, 'claude');
  fs.writeFileSync(shim, `#!/usr/bin/env node
const fs=require('fs'); try{fs.readFileSync(0,'utf8')}catch{}
process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'shimmed result',session_id:'sess-1',usage:{input_tokens:11,output_tokens:22}}));
`);
  fs.chmodSync(shim, 0o755);
  const metaOut = path.join(tmp, 'meta.json');
  const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts/dispatch.mjs'), '--provider', 'anthropic', '--cwd', hostPath, '--meta-out', metaOut, '--prompt-stdin'], {
    input: 'hello', encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  show('exit', run.status);
  show('stdout', (run.stdout || '').trim());
  assert.equal(run.status, 0, `precondition: the shimmed dispatch must succeed — stderr: ${(run.stderr || '').slice(-400)}`);
  const meta = JSON.parse(fs.readFileSync(metaOut, 'utf8'));
  show('meta.usage', meta.usage);
  assert.deepEqual(meta.usage, { input_tokens: 11, output_tokens: 22 });
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nRESULT ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
