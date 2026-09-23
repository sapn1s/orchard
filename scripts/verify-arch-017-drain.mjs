#!/usr/bin/env node
/**
 * ARCH-017 step 2 — THE GROUP-SETTLE DRAIN, NON-BLOCKING DISPATCH, AND THE
 * PENDING RAIL'S SERVER HALF, proven against the REAL broker socket, REAL
 * spawned children and the REAL ledger file on disk.
 *
 * The headline claim this file exists to demonstrate is a single number: a
 * fan-out of N background lanes is collected by ONE drain carrying N results,
 * instead of N deliveries. E1-E5 do that end to end through `op:'start'`, and
 * E6 shows the escape hatch (pull one result early while its siblings run).
 *
 * Every check prints OBSERVED VALUES and asserts its own preconditions first.
 * `--must-fail-proof` runs only the legs that prove the properties really were
 * breakable — a green with no must-FAIL behind it is decoration.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arch017-drain-'));
const DATA = path.join(tmp, 'data');
process.env.CLAUDE_STATION_DATA = DATA;
process.env.ORCHARD_DISPATCH_SCRIPT = path.join(ROOT, 'scripts', 'fixtures', 'fake-dispatch-lane.mjs');

const hostPath = path.join(tmp, 'repo');
fs.mkdirSync(hostPath, { recursive: true });
const project = { id: 'a17-drain', name: 'a17-drain', hostPath, isolation: 'direct', settings: { tools: { openaiDispatch: true } } };

const ONLY_MUST_FAIL = process.argv.includes('--must-fail-proof');
let pass = 0, fail = 0;
function check(name, fn) {
  if (ONLY_MUST_FAIL) return;
  try { fn(); pass++; console.log(`PASS ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}: ${e.message}`); }
}
async function checkAsync(name, fn) {
  if (ONLY_MUST_FAIL) return;
  try { await fn(); pass++; console.log(`PASS ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}: ${e.message}`); }
}
function mustFail(name, fn) {
  if (!ONLY_MUST_FAIL) return;
  try { fn(); pass++; console.log(`PASS MUST-FAIL ${name}`); }
  catch (e) { fail++; console.log(`FAIL MUST-FAIL ${name}: ${e.message}`); }
}
function show(label, value) { console.log(`      observed ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const lanes = await import('../src/server/lanes.ts');
const drain = await import('../src/server/lane-drain.ts');
const broker = await import('../src/server/dispatch-broker.ts');

/**
 * The receipt a genuine consumer produces: `sha256(nonce ‖ channel ‖ bytes)`
 * over the bundle it actually received, echoing the nonce and channel of THIS
 * send. Built from the store's own rule so the suites cannot drift from it.
 */
function honestReceipt(b, bundle = b.bundle) {
  return { bytes: b.receipt.bytes, nonce: b.receipt.nonce, channel: b.receipt.channel,
           digest: lanes.receiptDigest(b.receipt.nonce, b.receipt.channel, bundle) };
}

/** Read the ledger FILE, never a function's return value. */
function disk() { return JSON.parse(fs.readFileSync(lanes.laneStoreFile(), 'utf8')); }
function diskRec(id) { return disk().find((r) => r.id === id) ?? null; }

/** One NDJSON request on the real broker socket; resolves with every frame. */
function sockRequest(sock, req) {
  return new Promise((resolve, reject) => {
    const c = net.connect(sock);
    let buf = '';
    const frames = [];
    c.setEncoding('utf8');
    c.on('connect', () => c.write(`${JSON.stringify(req)}\n`));
    c.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (line.trim()) frames.push(JSON.parse(line));
      }
    });
    c.on('close', () => resolve(frames));
    c.on('error', reject);
    setTimeout(() => { c.destroy(); reject(new Error('socket timeout')); }, 60_000);
  });
}

const sock = await broker.start(project);
assert.equal(lanes.isWriter(), true, 'precondition: broker.start() must hold the writer claim for this data dir');

/* ═══════════════════════════ E — the real end-to-end fan-out ═══════════════ */

const GROUP = 'g-fanout-1';
let started = [];

/*
 * MEASURED, AND IT CHANGED THIS TEST: `PROJECT_CAP` is 2, so a naive
 * back-to-back fan-out of three had its THIRD start refused
 * (`op:'result', laneId:null`) — the cap is per-project and a BACKGROUND lane
 * holds its slot for its whole runtime, which is a far longer occupancy than
 * the blocking path ever had. The dispatcher therefore has to stage members
 * into an OPEN group as slots free, and that is not a workaround: it is
 * precisely the case hazard 2 exists for (a drain racing a newly dispatched
 * lane), so the fan-out below deliberately dispatches its third member AFTER
 * the first two have already settled.
 */
await checkAsync('E1 — op:"start" returns IMMEDIATELY with a lane id, and a third member joins an OPEN group later', async () => {
  const t0 = Date.now();
  const startOne = (i) => sockRequest(sock, {
    op: 'start', provider: 'openai', prompt: `lane ${i} delay=${i === 2 ? 2500 : 300}`,
    groupId: GROUP, groupSize: 3, groupOpen: true, parentSessionId: 'sess-parent-1',
  });
  started.push(await startOne(0));
  started.push(await startOne(1));
  const elapsed = Date.now() - t0;
  show('project concurrency cap', broker.PROJECT_CAP);
  // Wait for a slot, then add the third member to the STILL-OPEN group.
  for (let i = 0; i < 100 && disk().filter((r) => r.groupId === GROUP && r.state === 'settled').length < 2; i++) await sleep(100);
  show('members settled before the third was dispatched', disk().filter((r) => r.groupId === GROUP && r.state === 'settled').length);
  started.push(await startOne(2));
  const ids = started.map((f) => f[0]?.laneId);
  show('frames from the first start', started[0]);
  show('elapsed ms for all three starts', elapsed);
  show('lane ids', ids);
  assert.equal(started.length, 3, 'precondition: three starts were issued');
  for (const f of started) {
    assert.equal(f.length, 1, `a background start must send EXACTLY ONE frame and never the result; got ${JSON.stringify(f)}`);
    assert.equal(f[0].op, 'started');
    assert.ok(f[0].laneId, 'the caller must get the lane id back or it cannot reason about the group');
  }
  // The slow lane sleeps 2500ms; returning in well under that proves the call
  // did not block on the child. (A blocking dispatch of the same prompt cannot
  // return before its child exits.)
  assert.ok(elapsed < 2000, `the starts must return without blocking on their children; the first two took ${elapsed}ms`);
  const recs = ids.map(diskRec);
  show('ledger states right after start', recs.map((r) => ({ id: r.id, state: r.state, groupId: r.groupId, groupOpen: r.groupOpen, argvToken: r.argvToken ? 'set' : null, parentSessionId: r.parentSessionId })));
  assert.equal(recs.filter((r) => r.state === 'running').length, 1, 'precondition: the slow third member must still be running');
  for (const r of recs) {
    assert.ok(['running', 'settled'].includes(r.state), `a started lane is running or settled, never ${r.state}`);
    assert.equal(r.groupId, GROUP, 'group membership is DECLARED at dispatch, not derived');
    assert.equal(r.groupOpen, true);
    assert.ok(r.argvToken, 'argvToken must be written at BIRTH — a pid:null row is otherwise unrecoverable');
    assert.equal(r.parentSessionId, 'sess-parent-1', 'op:start declares the parent session; step 1 could not');
    assert.ok(r.groupCloseDeadline > Date.now(), 'an open group must carry a PERSISTED close deadline');
  }
});

const laneIds = started.map((f) => f[0].laneId);

await checkAsync('E1b — a start refused by the concurrency cap says so EXPLICITLY and records no lane', async () => {
  const before = disk().length;
  const hogs = await Promise.all([0, 1, 2].map((i) => sockRequest(sock, { op: 'start', provider: 'openai', prompt: `hang hog ${i}`, groupId: 'g-cap', groupSize: 3 })));
  const ops = hogs.map((f) => ({ op: f[0]?.op, kind: f[0]?.failureKind ?? f[0]?.kind ?? null, laneId: f[0]?.laneId ?? null }));
  show('three simultaneous starts against a cap of 2', ops);
  const refused = hogs.filter((f) => f[0]?.op !== 'started');
  // NOT "exactly one": E1's slow member may still hold a slot, so the number
  // refused depends on live occupancy. What must be true is that SOME start was
  // refused (or the cap is not being exercised) and that every refusal is loud.
  assert.ok(refused.length >= 1, `precondition: at least one start must exceed the cap of ${broker.PROJECT_CAP}; got ${JSON.stringify(ops)}`);
  for (const f of refused) assert.notEqual(f[0].op, 'started');
  assert.notEqual(refused[0][0].op, 'started', 'a refused start must NOT look like a started lane');
  assert.ok(JSON.stringify(refused[0][0]).includes('cap'), `the refusal must name the cap so the caller knows the lane never started; got ${JSON.stringify(refused[0][0])}`);
  show('ledger rows added', disk().length - before);
  assert.equal(disk().length - before, hogs.length - refused.length, 'a refused start must leave NO ledger row — a phantom member would hold its group open forever');
  for (const f of hogs) { const r = f[0]?.laneId && diskRec(f[0].laneId); if (r?.pid) { try { process.kill(r.pid, 'SIGKILL'); } catch { /* gone */ } } }
  // Drain ALL occupancy before the next test: a leftover slot makes the next
  // start cap-refused and the failure reads as a drain bug rather than a cap.
  for (let i = 0; i < 200 && disk().some((r) => r.state === 'running'); i++) await sleep(100);
  show('running lanes left before E2', disk().filter((r) => r.state === 'running').length);
});

check('E2 — HAZARD 2: while the group is OPEN the drain refuses, even with members already settled', () => {
  // The two fast lanes have settled by now; the slow one has not.
  const t = drain.groupTerminal(GROUP);
  show('groupTerminal', { terminal: t.terminal, why: t.why, state: t.state });
  assert.equal(t.state.open, true, 'precondition: the group must still be open for this to test anything');
  assert.equal(t.terminal, false, 'a still-open group must never drain — another member may be milliseconds away');
  assert.match(t.why, /still OPEN/);
});

await checkAsync('E3 — while the group is in flight, finished lanes appear INDIVIDUALLY with what they wait on', async () => {
  // Wait for the two fast lanes only.
  for (let i = 0; i < 100 && disk().filter((r) => r.groupId === GROUP && r.state === 'settled').length < 2; i++) await sleep(100);
  // Scoped to THIS group: the rail is global, and E1b's cap-refused hogs left
  // their own (legitimately ready) item behind. An unscoped assertion here
  // would be measuring a different group's lanes.
  const items = drain.pending({ projectId: project.id }).filter((i) => i.groupId === GROUP);
  show('pending items for this group', items.map((i) => ({ id: i.id, kind: i.kind, ready: i.ready, waitingOn: i.waitingOn, lanes: i.laneIds.length })));
  show('reason on the first', items[0]?.reason);
  assert.ok(items.length >= 2, `precondition: at least two lanes must have finished; got ${items.length}`);
  assert.ok(items.every((i) => i.kind === 'lane'), 'an in-flight group must NOT collapse to a group item — that would deliver a partial fan-out');
  assert.ok(items.every((i) => i.ready === false), 'nothing here is a complete unit yet');
  assert.ok(items.every((i) => i.waitingOn >= 1 || i.reason.includes('still open')));
});

let drained = null;

await checkAsync('E4 — when the group CLOSES and the last member settles, it collapses to ONE item carrying all three', async () => {
  // The dispatcher declares the group complete. The slow lane may still run.
  lanes.closeGroup(GROUP, 'the dispatcher finished declaring members');
  for (let i = 0; i < 200 && drain.groupTerminal(GROUP).terminal !== true; i++) await sleep(100);
  const t = drain.groupTerminal(GROUP);
  const items = drain.pending({ projectId: project.id }).filter((i) => i.groupId === GROUP);
  show('groupTerminal', { terminal: t.terminal, why: t.why });
  show('pending items', items.map((i) => ({ id: i.id, kind: i.kind, ready: i.ready, lanes: i.laneIds.length, label: i.label })));
  assert.equal(t.terminal, true, `precondition: the group must be terminal; ${t.why}`);
  assert.equal(items.length, 1, `THE HEADLINE CLAIM: a 3-lane fan-out must be ONE item, not three; got ${items.length}`);
  assert.equal(items[0].kind, 'group');
  assert.equal(items[0].ready, true);
  assert.equal(items[0].laneIds.length, 3, 'the one item must carry all three results');
});

check('E5 — ONE drain carries all three results, and only a real receipt acknowledges them', () => {
  const before = disk().filter((r) => r.groupId === GROUP);
  assert.equal(before.length, 3, `precondition: the group must have three records to collect; got ${before.length}`);
  assert.ok(before.every((r) => r.acknowledgedAt == null), 'precondition: nothing in this group is acknowledged yet');
  assert.ok(before.every((r) => r.handoffAt == null), 'precondition: nothing has been handed over yet');

  drained = drain.process([`group:${GROUP}`], { projectId: project.id });
  show('ONE drain returned', { itemIds: drained.itemIds, lanes: drained.lanes.length, bytes: drained.receipt.bytes, skipped: drained.skipped.length });
  show('bundle head', `${drained.bundle.slice(0, 180).replace(/\n/g, ' ⏎ ')}…`);
  assert.equal(drained.itemIds.length, 1, 'one click');
  assert.equal(drained.lanes.length, 3, 'three results, in one bundle');
  assert.ok(drained.bundle.length > 0);
  assert.equal(laneIds.length, 3, 'precondition: three lanes were dispatched, or the bundle-membership loop asserts nothing');
  for (const id of laneIds) assert.ok(drained.bundle.includes(id), `the bundle must carry lane ${id}`);

  const midway = disk().filter((r) => r.groupId === GROUP);
  show('after process, before ack', midway.map((r) => ({ id: r.id, handoff: r.handoffAt != null, acknowledged: r.acknowledgedAt != null })));
  assert.equal(midway.length, 3, `precondition: three records on disk before the receipt; got ${midway.length}`);
  assert.ok(midway.every((r) => r.handoffAt != null), 'Orchard must record its own half FIRST');
  assert.ok(midway.every((r) => r.acknowledgedAt == null), 'nothing may be acknowledged before a receipt — the response might never arrive');

  /*
   * ROUND 2 OF STEP 2 — THIS BLOCK USED TO ONLY `show()` ITS RESULT.
   *
   * An independent verifier deleted the possession comparison in a copy of the
   * tree and this suite still returned 13 PASS / 0 FAIL — E5 PRINTED the
   * forgery being accepted (`{"acknowledged":[3 lanes],"refused":[]}`) and
   * reported PASS anyway. Observation is not assertion, and a `show()` makes a
   * defect visible to a human reading the log while leaving it invisible to the
   * suite. Coverage existed only behind the optional `--must-fail-proof` flag,
   * so the headline "13 PASS" was not evidence for the load-bearing invariant
   * of the whole delivery discipline. Asserted now, in the DEFAULT run.
   */
  const bad = drain.acknowledge(laneIds, { bytes: drained.receipt.bytes, digest: 'f'.repeat(64) });
  show('acknowledge with a forged digest', bad);
  const afterBad = disk().filter((r) => r.groupId === GROUP);
  show('after the forged receipt', afterBad.map((r) => ({ acknowledged: r.acknowledgedAt != null })));
  assert.equal(bad.acknowledged.length, 0, 'a forged digest must acknowledge NOTHING — this is the invariant the whole delivery discipline rests on');
  assert.equal(bad.refused.length, laneIds.length, 'every lane must be refused by name, with a reason');
  // ROUND 8 (cross-provider finding 5): `afterBad.every(...)` is vacuously true on
  // an empty disk read, so afterBad's OWN cardinality is pinned here — the sibling
  // `before`/`midway` counts are separate reads and do not prove THIS one is full.
  assert.equal(afterBad.length, 3, `precondition: the disk still holds all three lanes; got ${afterBad.length}`);
  assert.ok(afterBad.every((r) => r.acknowledgedAt == null), 'and the DISK must be unchanged — an in-memory refusal that still stamps the file proves nothing');
  // The forged receipt now fails the NONCE check before the digest check (it
  // carries no nonce at all), so the reason names that instead of possession.
  // Asserted as "a refusal reason naming one of the receipt rules", not as one
  // fixed sentence — otherwise the test breaks every time the rule is tightened.
  assert.ok(afterBad.every((r) => /did not prove possession|not for THIS send|does not state the destination/.test(r.heldReason || '')),
    `each refused lane must record WHY it is still held; got ${JSON.stringify(afterBad.map((r) => (r.heldReason || '').slice(0, 50)))}`);

  // ROUND 11 (finding 1) — THE RESPONSE MUST NOT CARRY THE COMPARISON VALUE.
  // The digest is reproducible from the bytes PLUS this send's nonce and channel
  // (the store's own rule, `lanes.receiptDigest`), so a HOLDER of the bytes can
  // compute it — but the response must NEVER hand it over, or echoing it back
  // acknowledges bytes nobody saw. So: the response carries no `digest`, and the
  // honest receipt (computed from the bundle) is what the store accepts.
  const digest = honestReceipt(drained).digest;
  assert.equal(drained.receipt.digest, undefined, 'the drain response must NOT include the expected digest — the sender never transmits the value acknowledge() compares against (finding 1)');
  const ok = drain.acknowledge(laneIds, honestReceipt(drained));
  show('acknowledge with the real receipt', { acknowledged: ok.acknowledged.length, refused: ok.refused.length });
  const after = disk().filter((r) => r.groupId === GROUP);
  show('disk after the real receipt', after.map((r) => ({ id: r.id, acknowledged: r.acknowledgedAt != null, by: r.acknowledgedBy, heldReason: r.heldReason })));
  assert.equal(ok.acknowledged.length, 3);
  /*
   * CARDINALITY FIRST — `[].every(...)` is `true`. A cross-provider review
   * extracted this very line and showed `after=[] PASS`: had the group query
   * returned nothing, "all three collected" would have been certified by an
   * empty array. Every `.every()` below is now preceded by the count it is
   * supposed to be talking about.
   */
  assert.equal(after.length, 3, `precondition: the group must really have three records on disk; got ${after.length}`);
  assert.ok(after.every((r) => r.acknowledgedAt != null), 'all three collected in ONE drain');
  assert.ok(after.every((r) => r.heldReason == null), 'a collected result must stop saying why it is held (round-7 rule 1a)');
  assert.deepEqual(drain.pending({ projectId: project.id }).filter((i) => i.groupId === GROUP), [], 'this group leaves the rail entirely once it is collected');
});

/* ═══════════════════════ E6 — the escape hatch, end to end ═════════════════ */

await checkAsync('E6 — ESCAPE HATCH: a finished result is processed EARLY while a sibling still runs', async () => {
  const G2 = 'g-escape-1';
  const fast = (await sockRequest(sock, { op: 'start', provider: 'openai', prompt: 'quick lane delay=200', groupId: G2, groupSize: 2, groupOpen: false }))[0];
  const slow = (await sockRequest(sock, { op: 'start', provider: 'openai', prompt: 'hang', groupId: G2, groupSize: 2, groupOpen: false }))[0];
  for (let i = 0; i < 100 && diskRec(fast.laneId)?.state !== 'settled'; i++) await sleep(100);
  assert.equal(fast.op, 'started', `precondition: the fast lane must really have started; got ${JSON.stringify(fast)}`);
  assert.equal(slow.op, 'started', `precondition: the sibling must really have started; got ${JSON.stringify(slow)}`);
  const slowRec = diskRec(slow.laneId);
  assert.equal(slowRec.state, 'running', 'precondition: the sibling must still be RUNNING or this proves nothing');
  const items = drain.pending({ projectId: project.id });
  const mine = items.find((i) => i.laneIds.includes(fast.laneId));
  show('the early item', { id: mine.id, ready: mine.ready, waitingOn: mine.waitingOn, reason: mine.reason });
  assert.equal(mine.ready, false, 'it is honestly not a complete unit');
  assert.equal(mine.waitingOn, 1);

  const b = drain.process([mine.id], { projectId: project.id });
  drain.acknowledge(b.lanes.map((l) => l.id), honestReceipt(b), 'user');
  const after = diskRec(fast.laneId);
  show('the early-pulled lane on disk', { acknowledged: after.acknowledgedAt != null, by: after.acknowledgedBy });
  show('the sibling, untouched', { state: diskRec(slow.laneId).state, acknowledged: diskRec(slow.laneId).acknowledgedAt != null });
  assert.equal(b.lanes.length, 1, 'the escape hatch pulls ONE result, not the group');
  assert.ok(after.acknowledgedAt != null, 'the early pull really collected it');
  assert.equal(after.acknowledgedBy, 'user');
  assert.equal(diskRec(slow.laneId).state, 'running', 'the running sibling must be untouched by an early pull');
  assert.ok(!drain.pending({ projectId: project.id }).some((i) => i.laneIds.includes(fast.laneId)), 'the collected item leaves the rail');
  try { process.kill(slowRec.pid, 'SIGKILL'); } catch { /* already gone */ }
});

/* ═════════ R — the re-offer path, from the independent verify (round 2) ════ */

/**
 * THE STRANDING BUG, as a permanent regression.
 *
 * An independent verifier proved that a lane first handed over inside one
 * bundle and later re-offered in a DIFFERENT selection could never be
 * acknowledged again: `process()` computes the digest over the current
 * selection while `markHandoff()` was first-wins and kept the original. Three
 * retries, `{"acknowledged":0,"refused":2}` every time, and the only way to
 * clear the rail was to DISCARD the results. This is the path the drain's own
 * header advertises as "re-offered, not lost", so it was the contract failing
 * on its own documented route.
 */
check('R1 — a lane re-drained in a DIFFERENT selection can still be acknowledged (lost-ack retry)', () => {
  const G = 'g-restrand';
  lanes.openGroup(G, { ttlMs: 60 * 60 * 1000, members: [
    { label: 'strand a', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, state: 'pending' },
    { label: 'strand b', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, state: 'pending' },
    { label: 'strand c (slow)', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, state: 'pending' },
  ] });
  const rows = lanes.list({ groupId: G }).sort((a, b) => a.id.localeCompare(b.id));
  for (const r of rows) lanes.promotePending(r.id, process.pid, `tok-${r.id}`);
  lanes.settle(rows[0].id, { state: 'settled', resultText: 'AAA result for strand a' });
  lanes.settle(rows[1].id, { state: 'settled', resultText: 'BBB result for strand b' });

  // Two EARLY pulls, each its own single-lane bundle. Both acks are lost (the
  // browser died / the response never arrived) — nothing is acknowledged.
  const earlyA = drain.process([`lane:${rows[0].id}`], { projectId: project.id });
  const earlyB = drain.process([`lane:${rows[1].id}`], { projectId: project.id });
  show('early pull A', { lanes: earlyA.lanes.length, bytes: earlyA.receipt.bytes, digest: honestReceipt(earlyA).digest.slice(0, 12) });
  show('early pull B', { lanes: earlyB.lanes.length, bytes: earlyB.receipt.bytes, digest: honestReceipt(earlyB).digest.slice(0, 12) });
  assert.equal(earlyA.lanes.length, 1, 'precondition: A was handed over on its own');
  assert.equal(earlyB.lanes.length, 1, 'precondition: B was handed over on its own');
  assert.ok(disk().filter((r) => r.groupId === G).every((r) => r.acknowledgedAt == null), 'precondition: both acks were LOST — nothing is acknowledged');

  // Now the slow sibling finishes and the group closes: the rail collapses the
  // three into ONE item, so the per-lane bundles can never be reproduced.
  lanes.settle(rows[2].id, { state: 'settled', resultText: 'CCC result for strand c' });
  lanes.closeGroup(G, 'the dispatcher finished');
  const items = drain.pending({ projectId: project.id }).filter((i) => i.groupId === G);
  show('rail after the group completes', items.map((i) => ({ id: i.id, ready: i.ready, lanes: i.laneIds.length })));
  assert.equal(items.length, 1, 'precondition: the rail now offers them ONLY together — the exact shape that used to strand them');
  assert.equal(items[0].laneIds.length, 3);

  const b = drain.process([items[0].id], { projectId: project.id });
  const ok = drain.acknowledge(b.lanes.map((l) => l.id), honestReceipt(b));
  const after = disk().filter((r) => r.groupId === G);
  assert.equal(after.length, 3, `precondition: the group still has all three records on disk; got ${after.length}`);
  show('group drain acknowledged', ok.acknowledged.length);
  show('group drain refused', ok.refused.map((r) => r.why.slice(0, 70)));
  show('on disk', after.map((r) => ({ id: r.id.slice(-6), ack: r.acknowledgedAt != null, heldReason: r.heldReason })));
  assert.equal(ok.refused.length, 0, `no lane may be stranded by an earlier lost ack; refused: ${JSON.stringify(ok.refused)}`);
  assert.equal(ok.acknowledged.length, 3, 'ALL THREE collect, including the two whose first receipt never came back');
  assert.ok(after.every((r) => r.acknowledgedAt != null), 'and the disk agrees');
  // Same query as `items` above (asserted length 1), so "it left the rail" is a
  // claim about a collection we proved was NON-empty — not vacuously true on [].
  const railAfter = drain.pending({ projectId: project.id }).filter((i) => i.groupId === G);
  assert.deepEqual(railAfter, [], 'the item really leaves the rail — it is not clearable only by discarding');
});

check('R2 — the FIRST handoff time is preserved across a re-send, and a collected lane refuses one', () => {
  const G = 'g-restamp-facts';
  lanes.openGroup(G, { ttlMs: 60_000, members: [{ label: 'restamp', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, state: 'pending' }] });
  const r = lanes.list({ groupId: G })[0];
  lanes.promotePending(r.id, process.pid, 'tok');
  lanes.settle(r.id, { state: 'settled', resultText: 'once' });
  lanes.closeGroup(G, 'x');
  const first = drain.process([`group:${G}`], { projectId: project.id });
  const firstAt = diskRec(r.id).handoffAt;
  assert.ok(firstAt != null, 'precondition: a first handoff exists');
  const second = drain.process([`group:${G}`], { projectId: project.id });
  const rec = diskRec(r.id);
  show('handoffAt across a re-send', { first: firstAt, afterResend: rec.handoffAt, unchanged: rec.handoffAt === firstAt });
  const secondDigest = honestReceipt(second).digest; // computed, not read from the response (finding 1)
  show('expected digest now names the LATEST send', { matchesSecond: rec.handoffEvidence.includes(secondDigest) });
  assert.equal(rec.handoffAt, firstAt, '"when Orchard first handed this over" is a fact and must not move');
  assert.ok(rec.handoffEvidence.includes(secondDigest), 'but the expected digest must describe the send a receipt will be checked against');
  const ok = drain.acknowledge([r.id], honestReceipt(second));
  assert.equal(ok.acknowledged.length, 1, 'precondition: it collects');
  let threw = null;
  try { lanes.restampHandoff(r.id, 1, 'sha256=' + '0'.repeat(64)); } catch (e) { threw = e.message.slice(0, 90); }
  show('re-stamping an ALREADY-COLLECTED lane', threw);
  assert.ok(threw, 're-stamping a collected result would invalidate the receipt that collected it — it must be refused');
  assert.ok(threw.includes('already acknowledged'));
});

/**
 * R3 — THE `heldReason` LIFECYCLE, ACROSS EVERY WRITER THAT CAN INVALIDATE IT.
 *
 * An independent verifier found `restampHandoff` leaving a stale reason behind
 * (a record naming an expected digest that is no longer expected) and asked
 * whether any OTHER writer had the same gap. Four did. So this does not test
 * the one function that was reported — it tests the RULE, over every writer,
 * because fixing one call site is what produced the defect in the first place
 * (round 7 fixed `markAcknowledged` alone).
 *
 * The hazard is not cosmetic: `verify-lane-ledger.mjs`'s `heldBecause()` gate
 * asserts `heldReason.includes(frag)` and guards only against an ACKNOWLEDGED
 * record, so a stale reason surviving any writer below could satisfy a future
 * refusal assertion with no refusal having happened.
 */
check('R3 — every writer that invalidates a held result also clears its heldReason', () => {
  const stale = 'STALE-REASON-FROM-AN-EARLIER-REFUSAL';
  /*
   * ROUND 4 — PLANTED ON DISK, because `markHeldReason()` now REFUSES a
   * running, pending or dismissed record (the round-3 verify's finding 4: the
   * write side had no state guard). That guard is correct, and it means a
   * not-yet-terminal record can no longer be given a reason through the API at
   * all — so the only way one can now exist is a file that ARRIVED that way
   * (hand-edited, half-written, or written by an older build). That is exactly
   * what the clearers are defence against, so the fixture writes it straight to
   * the ledger rather than faking a call path that no longer exists.
   */
  function plantReasonOnDisk(id, why) {
    const file = lanes.laneStoreFile();
    const all = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rec = all.find((r) => r.id === id);
    assert.ok(rec, `precondition: ${id} must be in the ledger to plant a reason on it`);
    rec.heldReason = why;
    fs.writeFileSync(file, JSON.stringify(all, null, 2));
  }
  /** A fresh settled+held lane carrying a refusal reason, ready to be acted on. */
  function heldLane(label) {
    const g = `g-lifecycle-${label}`;
    lanes.openGroup(g, { ttlMs: 60 * 60 * 1000, members: [{ label, charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, state: 'pending' }] });
    const row = lanes.list({ groupId: g })[0];
    lanes.promotePending(row.id, process.pid, 'tok');
    lanes.settle(row.id, { state: 'settled', resultText: `result for ${label}` });
    lanes.markHeldReason(row.id, stale);
    assert.equal(diskRec(row.id).heldReason, stale, `precondition: ${label} must really be carrying a stale reason`);
    return { g, id: row.id };
  }

  const observed = {};

  // 2. restampHandoff — the RE-send. This is the reported defect.
  {
    const { id } = heldLane('restamp');
    lanes.markHandoff(id, 10, 'sha256=' + 'a'.repeat(64));
    lanes.markHeldReason(id, stale);
    lanes.restampHandoff(id, 20, 'sha256=' + 'b'.repeat(64));
    observed.restampHandoff = diskRec(id).heldReason;
  }
  // 3. dismiss — `dismissedAt` makes isHeld() false. The markAcknowledged case.
  {
    const { id } = heldLane('dismiss');
    lanes.dismiss([id]);
    observed.dismiss = diskRec(id).heldReason;
    assert.equal(lanes.isHeld(diskRec(id)), false, 'precondition: a dismissed record is no longer held');
  }
  // 4. settle — a reason from while it was RUNNING must not survive.
  {
    const g = 'g-lifecycle-settle2';
    lanes.openGroup(g, { ttlMs: 60_000, members: [{ label: 'settle2', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, state: 'pending' }] });
    const row = lanes.list({ groupId: g })[0];
    lanes.promotePending(row.id, process.pid, 'tok');
    plantReasonOnDisk(row.id, stale);
    assert.equal(diskRec(row.id).heldReason, stale, 'precondition: a running lane carrying a reason');
    lanes.settle(row.id, { state: 'settled', resultText: 'x' });
    observed.settle = diskRec(row.id).heldReason;
  }
  // 5. promotePending — a lane that is STARTING is not a lane being held.
  {
    const g = 'g-lifecycle-promote';
    lanes.openGroup(g, { ttlMs: 60_000, members: [{ label: 'promote', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, state: 'pending' }] });
    const row = lanes.list({ groupId: g })[0];
    plantReasonOnDisk(row.id, stale);
    assert.equal(diskRec(row.id).heldReason, stale, 'precondition: a pending lane carrying a reason');
    lanes.promotePending(row.id, process.pid, 'tok');
    observed.promotePending = diskRec(row.id).heldReason;
  }
  // 6. markAcknowledged — the round-7 fix, pinned here too so the rule is one test.
  {
    const { id } = heldLane('ack');
    lanes.markHandoff(id, 10, 'sha256=' + 'c'.repeat(64));
    lanes.markHeldReason(id, stale);
    lanes.markAcknowledged(id, 'user', 'ev', 'proof');
    observed.markAcknowledged = diskRec(id).heldReason;
  }

  show('heldReason on disk after each writer', observed);
  const offenders = Object.entries(observed).filter(([, v]) => v != null).map(([k, v]) => `${k} left ${JSON.stringify(String(v).slice(0, 40))}`);
  show('writers leaving a stale reason', offenders.length ? offenders : 'none');
  assert.deepEqual(offenders, [], 'a record that is no longer held — or whose send has changed — must not still say why it was held');

  // And the rule must not overreach: a genuine refusal still records its reason.
  const { id } = heldLane('genuine');
  lanes.markHandoff(id, 10, 'sha256=' + 'd'.repeat(64));
  const refusedOut = drain.acknowledge([id], { bytes: 999, digest: 'e'.repeat(64) });
  show('a GENUINE refusal still records a reason', { refused: refusedOut.refused.length, reason: (diskRec(id).heldReason || '').slice(0, 60) });
  assert.equal(refusedOut.acknowledged.length, 0, 'precondition: this receipt is bogus');
  assert.ok(diskRec(id).heldReason, 'clearing must not become "never record a reason" — that would make every refusal assertion vacuous');
});

/**
 * R3c — THE WRITE SIDE REFUSES A REASON A RECORD CANNOT HONESTLY CARRY.
 *
 * Round 3 fixed every writer that INVALIDATES a reason and left the one that
 * CREATES them guarded only on `acknowledgedAt`. A verifier drove the two real
 * routes into it — both reachable from `POST /api/lanes/ack`, which accepts
 * arbitrary lane ids — and got a "why it is held" sentence onto records that
 * were not held:
 *
 *   dismiss-races-a-drain : {"held":false,"dismissedAt":true,"heldReason":"…did not prove possession…"}
 *   an ack for a RUNNING lane : {"state":"running","heldReason":"Orchard has no record of sending…"}
 *
 * Driven here through `drain.acknowledge()` — the real caller — rather than
 * through `markHeldReason` directly, because the guard is only worth having if
 * it holds on the path an HTTP client can actually reach.
 */
check('R3c — a dismissed or still-running record cannot be given a "why it is held" reason', () => {
  function lane(label) {
    const g = `g-guard-${label}`;
    lanes.openGroup(g, { ttlMs: 60 * 60 * 1000, members: [{ label, charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, state: 'pending' }] });
    const row = lanes.list({ groupId: g })[0];
    lanes.promotePending(row.id, process.pid, 'tok');
    return row.id;
  }

  // (a) DISMISS RACES THE DRAIN: handed over, then discarded, then a bogus ack.
  const a = lane('dismissed');
  lanes.settle(a, { state: 'settled', resultText: 'discarded result' });
  lanes.markHandoff(a, 10, 'sha256=' + 'a'.repeat(64));
  lanes.dismiss([a]);
  assert.equal(lanes.isHeld(diskRec(a)), false, 'precondition: a dismissed record is NOT held');
  const outA = drain.acknowledge([a], { bytes: 1, digest: 'f'.repeat(64) });
  const recA = diskRec(a);
  show('dismissed record after a refused ack', { refused: outA.refused.length, held: lanes.isHeld(recA), dismissedAt: recA.dismissedAt != null, heldReason: recA.heldReason });
  assert.equal(outA.acknowledged.length, 0, 'precondition: the bogus receipt is still refused');
  assert.equal(recA.heldReason, null, 'a DISCARDED result must not be told why it is being held');

  // (b) AN ACK NAMING A LANE THAT IS STILL RUNNING.
  const b = lane('running');
  assert.equal(diskRec(b).state, 'running', 'precondition: this lane really is still running');
  const outB = drain.acknowledge([b], { bytes: 1, digest: 'f'.repeat(64) });
  const recB = diskRec(b);
  show('running record after a refused ack', { refused: outB.refused.length, state: recB.state, heldReason: recB.heldReason });
  assert.equal(outB.acknowledged.length, 0, 'precondition: it is refused — there is no handoff behind it');
  assert.equal(recB.heldReason, null, 'a lane that has not finished is not "held"; a reason here is a statement about a state it is not in');

  // …and the guard must not swallow the case it exists to serve.
  const c = lane('genuine');
  lanes.settle(c, { state: 'settled', resultText: 'genuinely held' });
  lanes.markHandoff(c, 10, 'sha256=' + 'c'.repeat(64));
  const outC = drain.acknowledge([c], { bytes: 1, digest: 'f'.repeat(64) });
  show('a genuinely held record after a refused ack', { refused: outC.refused.length, heldReason: (diskRec(c).heldReason || '').slice(0, 60) });
  assert.ok(diskRec(c).heldReason, 'a terminal, undelivered, undismissed record MUST still record why it is held — otherwise every refusal assertion goes vacuous');
});

/*
 * R3b — THE WRITER THAT MUST *NOT* CLEAR, AND THE ORDERING THAT PROVES IT.
 *
 * Round 8 added `markHandoff` to the clearing rule above on the reasoning "a
 * fresh send makes any earlier refusal reason stale", and it turned D4 in
 * `verify-lane-ledger.mjs` red on the spot (62 PASS / 1 FAIL, "VACUOUS: this
 * lane is held but the receipt rule recorded NO refusal reason"). The reasoning
 * is wrong on both halves and this test pins both:
 *
 *   - A handoff GRANTS NOTHING (`isHeld()` is still true after it), so the
 *     reason still describes the record's current state. Clearing it recreates
 *     round-7 finding 1b: held, with no explanation.
 *   - "EARLIER" is false on the real wire. The no-ack broker path calls
 *     `socket.end(line, cb)` and then runs the receipt rule's refusal
 *     SYNCHRONOUSLY, while `cb` (→ `markHandoff`) fires later on the write
 *     callback. The reason being wiped is the verdict about THIS send.
 *
 * The second half is replayed here in the real broker order rather than
 * described, so a future "tidy-up" that re-adds the clear fails here too and
 * not only three hundred lines away in another suite.
 */
check('R3b — markHandoff LEAVES the reason standing: a handed-off lane is still held, and the no-ack refusal lands BEFORE the write callback', () => {
  const stale = 'the peer did not request a delivery receipt (no "ack" in its request), so nothing proves it holds the result';

  function freshHeld(label) {
    const g = `g-r3b-${label}`;
    lanes.openGroup(g, { ttlMs: 60 * 60 * 1000, members: [{ label, charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, state: 'pending' }] });
    const row = lanes.list({ groupId: g })[0];
    lanes.promotePending(row.id, process.pid, 'tok');
    lanes.settle(row.id, { state: 'settled', resultText: `result for ${label}` });
    return row.id;
  }

  // (a) the plain rule: a reason on the record survives the handoff.
  const a = freshHeld('survives');
  lanes.markHeldReason(a, stale);
  lanes.markHandoff(a, 10, 'sha256=' + 'a'.repeat(64));
  const afterA = diskRec(a);
  show('after markHandoff', { heldReason: (afterA.heldReason || '(NONE)').slice(0, 64), handoffAt: afterA.handoffAt != null, held: lanes.isHeld(afterA) });
  assert.equal(lanes.isHeld(afterA), true, 'precondition: a handoff grants nothing, so the record must still be held — if this ever goes false the clearing rule WOULD apply here');
  assert.ok(afterA.heldReason, 'VACUOUS-BY-SILENCE: the record is held and nothing on disk says why — round-7 finding 1b, reintroduced by the clearing rule');
  assert.ok(afterA.heldReason.includes('did not request a delivery receipt'), `the standing reason must survive verbatim, got ${JSON.stringify((afterA.heldReason || '').slice(0, 80))}`);

  // (b) the real broker ORDER: end-with-callback first, refusal synchronously,
  //     handoff on the write callback afterwards.
  const b = freshHeld('ordering');
  const order = [];
  let writeCb = null;
  const fakeEnd = (_line, cb) => { writeCb = cb; };      // the socket has not flushed yet
  fakeEnd('frame\n', () => { order.push('markHandoff'); lanes.markHandoff(b, 10, 'sha256=' + 'b'.repeat(64)); });
  order.push('markHeldReason'); lanes.markHeldReason(b, stale);   // onOutcome(), synchronous
  writeCb();                                                       // the flush lands later
  const afterB = diskRec(b);
  show('call order as the broker really makes it', order);
  show('on disk after both', { heldReason: (afterB.heldReason || '(NONE)').slice(0, 64), handoffAt: afterB.handoffAt != null, held: lanes.isHeld(afterB) });
  assert.deepEqual(order, ['markHeldReason', 'markHandoff'], 'precondition: the refusal must genuinely be written BEFORE the handoff, or this is not the production order');
  assert.ok(afterB.heldReason, 'VACUOUS: the handoff write callback wiped the refusal that the receipt rule had just recorded for this very send — exactly the D4 failure');
  assert.equal(lanes.isHeld(afterB), true);
});

/*
 * R4 — THE BYTE COUNT IS CHECKED, NOT ONLY THE DIGEST (mutant M17, a genuine
 * survivor found by the round-3 mutation run).
 *
 * `acknowledge()` tests two things: `got === want` (the digest) AND
 * `Number.isFinite(receipt.bytes) && receipt.bytes === rec.handoffBytes`. Delete
 * the second half and every suite stayed green — the count arm was exercised
 * ONLY in `--must-fail-proof` leg 2, which is the mode nobody runs by reflex.
 * That is exactly the "guarded only in the optional mode" hole this harness
 * exists to find, so the property moves into the DEFAULT run.
 *
 * Why the arm is not redundant with the digest: the digest proves possession of
 * the bytes, and the count is a SEPARATE claim the peer makes about the same
 * send. A receipt that gets one right and the other wrong is a peer that is
 * wrong or lying about something, and "trust it on the half that checks out" is
 * how a delivery gets stamped on a partial write.
 */
check('R4 — a receipt with the CORRECT digest but a wrong or non-finite BYTE COUNT is refused (mutant M17)', () => {
  const G = 'g-r4-bytecount';
  lanes.openGroup(G, { ttlMs: 60_000, members: [{ label: 'bytecount', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, state: 'pending' }] });
  const row = lanes.list({ groupId: G })[0];
  lanes.promotePending(row.id, process.pid, 'tok');
  lanes.settle(row.id, { state: 'settled', resultText: 'R4 PAYLOAD'.padEnd(600, '.') });
  lanes.closeGroup(G, 'r4');
  const b = drain.process([`group:${G}`], { projectId: project.id });
  assert.equal(b.lanes.length, 1, 'precondition: the lane must really have been handed over');
  const trueDigest = honestReceipt(b).digest;
  assert.equal(b.receipt.digest, undefined, 'precondition (finding 1): the response carries no digest; the holder computes it from the bytes');

  const observed = [];
  for (const [tag, bytes] of [['one byte short', b.receipt.bytes - 1], ['one byte long', b.receipt.bytes + 1], ['zero', 0], ['NaN', NaN], ['a string', String(b.receipt.bytes)]]) {
    const out = drain.acknowledge([row.id], { ...honestReceipt(b), bytes });
    const rec = diskRec(row.id);
    observed.push({ claims: tag, bytes: String(bytes), acknowledged: out.acknowledged.length, onDisk: rec.acknowledgedAt != null, why: (out.refused[0]?.why ?? '').slice(0, 52) });
  }
  assert.equal(observed.length, 5, 'precondition: all five byte-count cases ran, or the loop below asserts nothing');
  for (const o of observed) show(`count ${o.claims}`, o);
  for (const o of observed) {
    assert.equal(o.acknowledged, 0, `a receipt claiming ${o.claims} was ACCEPTED on its digest alone — the count arm is gone`);
    assert.equal(o.onDisk, false, `${o.claims} reached the ledger, which is the data-loss-adjacent case: a delivery stamped on a half-checked receipt`);
    assert.ok(o.why.length > 0, `VACUOUS for ${o.claims}: refused with no reason, so nothing proves the count was what refused it`);
  }

  // And the rule must not overreach: the HONEST receipt still acknowledges.
  const good = drain.acknowledge([row.id], honestReceipt(b));
  show('the honest receipt', { acknowledged: good.acknowledged.length, onDisk: diskRec(row.id).acknowledgedAt != null });
  assert.equal(good.acknowledged.length, 1, 'refusing everything would make this test vacuous — a correct receipt must still be accepted');
});

/* ════ X — the FIRST CROSS-PROVIDER review of step 2, adopted verbatim ═════ */
/*
 * Three same-family verification rounds passed everything below. A
 * cross-provider reviewer broke five properties in minutes, by extracting the
 * production functions and asserting against temporary JSON ON DISK. Its
 * probes are adopted here the way V1-V8 were, each asserting the FIXED
 * behaviour and printing the observed values the review printed.
 *
 * Reproducer for the originals: `node /tmp/arch017-qa.mjs` (it now throws at
 * case 1, because case 1 asserted that the defect was accepted).
 */

check('X1 — a late joiner CANNOT re-open a closed group, so a delivered group is never delivered twice', () => {
  const G = 'g-x1';
  const a = lanes.recordDispatch({ label: 'x1a', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, groupId: G }).id;
  lanes.settle(a, { state: 'settled', resultText: 'RESULT-a' });
  lanes.closeGroup(G, 'x1');
  const first = drain.process([`group:${G}`], { projectId: project.id });
  drain.acknowledge([a], { ...first.receipt, digest: lanes.receiptDigest(first.receipt.nonce, first.receipt.channel, first.bundle) });
  assert.equal(diskRec(a).acknowledgedAt != null, true, 'precondition: the group was really delivered once');

  let threw = null;
  try { lanes.recordDispatch({ label: 'x1b', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, groupId: G }, 'x1-late'); }
  catch (e) { threw = e; }
  const rows = disk().filter((r) => r.groupId === G);
  const second = drain.process([`group:${G}`], { projectId: project.id });
  show('late join into a CLOSED, already-delivered group', threw ? `REFUSED (${threw.code}): ${threw.message.slice(0, 80)}` : 'ACCEPTED');
  show('rows in the group / lanes a second drain would carry', { rows: rows.length, secondDrainLanes: second.lanes.length });
  assert.ok(threw, 'a closed group must refuse new members — otherwise closeGroup() is advisory and the barrier the one-wakeup design rests on does not exist');
  assert.equal(threw.code, 'group-closed');
  assert.equal(rows.length, 1, 'the late row must not be in the ledger at all');
  assert.equal(second.lanes.length, 0, 'and the group must NOT deliver a second time');
});

check('X2 — a duplicate lane id is refused, so no row can be unreachable-and-blocking', () => {
  const G = 'g-x2';
  const a = lanes.recordDispatch({ label: 'x2a', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, groupId: G }, 'x2-dup').id;
  let threw = null;
  try { lanes.recordDispatch({ label: 'x2b', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, groupId: G }, 'x2-dup'); }
  catch (e) { threw = e; }
  lanes.settle(a, { state: 'settled', resultText: 'RESULT-a' });
  const rows = disk().filter((r) => r.groupId === G);
  const st = lanes.groupState(G);
  show('second recordDispatch with the same id', threw ? `REFUSED (${threw.code})` : 'ACCEPTED');
  show('rows / outstanding after settle', { rows: rows.length, outstanding: st.outstanding });
  assert.ok(threw, 'the ledger resolves every id with find(), so a duplicate row is unreachable to settle() and blocks its group forever');
  assert.equal(threw.code, 'duplicate-id');
  assert.equal(rows.length, 1);
  assert.equal(st.outstanding, 0, 'settling the one row must complete the group');
});

check('X3 — dismissing the last RUNNING member completes the group instead of hanging it forever', () => {
  const G = 'g-x3';
  const a = lanes.recordDispatch({ label: 'x3a', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, groupId: G }).id;
  const b = lanes.recordDispatch({ label: 'x3b', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, groupId: G }).id;
  lanes.settle(a, { state: 'settled', resultText: 'RESULT-a' });
  assert.equal(diskRec(b).state, 'running', 'precondition: b is still running');
  assert.equal(lanes.groupState(G).outstanding, 1, 'precondition: the group is waiting on exactly b');
  lanes.dismiss([b]);
  const st = lanes.groupState(G);
  const t = drain.groupTerminal(G);
  show('after dismissing the last running member', { outstanding: st.outstanding, terminal: t.terminal, why: t.why.slice(0, 70) });
  assert.equal(st.outstanding, 0, 'nothing will ever settle a row the user discarded, so it cannot be waited on');
  assert.equal(t.terminal, true, 'the group must complete, or every sibling result is undeliverable forever');
  const items = drain.pending({ projectId: project.id }).filter((i) => i.groupId === G);
  show('rail item for the group', items.map((i) => ({ id: i.id, ready: i.ready, lanes: i.laneIds.length })));
  assert.equal(items.length, 1, 'and the surviving result is offered');
  assert.equal(items[0].ready, true);
});

check('X4 — a receipt from an EARLIER drain cannot acknowledge a later identical bundle, and the channel is required', () => {
  const G = 'g-x4';
  const a = lanes.recordDispatch({ label: 'x4a', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, groupId: G }).id;
  lanes.settle(a, { state: 'settled', resultText: 'RESULT-a' });
  lanes.closeGroup(G, 'x4');
  const first = drain.process([`group:${G}`], { projectId: project.id });
  const second = drain.process([`group:${G}`], { projectId: project.id });
  const honest = (r) => ({ ...r.receipt, digest: lanes.receiptDigest(r.receipt.nonce, r.receipt.channel, r.bundle) });
  show('the two sends', { identicalBundles: first.bundle === second.bundle, differentNonces: first.receipt.nonce !== second.receipt.nonce });
  assert.equal(first.bundle, second.bundle, 'precondition: the two bundles are byte-identical — only the nonce distinguishes them');
  assert.notEqual(first.receipt.nonce, second.receipt.nonce, 'precondition: each send must mint a fresh nonce');

  const replay = drain.acknowledge([a], honest(first));
  show('REPLAY: the first send\'s receipt against the second send', { acknowledged: replay.acknowledged.length, why: (replay.refused[0]?.why ?? '').slice(0, 80) });
  assert.equal(replay.acknowledged.length, 0, 'an old receipt must not acknowledge a later send');
  assert.equal(diskRec(a).acknowledgedAt, null, 'and the DISK must be unchanged');

  const noChannel = drain.acknowledge([a], { bytes: second.receipt.bytes, digest: honest(second).digest, nonce: second.receipt.nonce });
  show('NO CHANNEL: possession only', { acknowledged: noChannel.acknowledged.length, why: (noChannel.refused[0]?.why ?? '').slice(0, 80) });
  assert.equal(noChannel.acknowledged.length, 0, 'possession alone is not delivery — the destination must be stated');
  assert.equal(diskRec(a).acknowledgedAt, null);

  const wrongChannel = drain.acknowledge([a], { ...honest(second), channel: 'somewhere-else' });
  show('WRONG CHANNEL', { acknowledged: wrongChannel.acknowledged.length });
  assert.equal(wrongChannel.acknowledged.length, 0);

  /*
   * The digest already incorporates the nonce, so a naive replay also fails the
   * digest check. The EXPLICIT nonce check is what refuses a receipt whose
   * digest is correct but whose DECLARED nonce is stale — a caller that
   * recomputed the digest but echoed the wrong send. Without this case the
   * explicit check is unasserted (mutant Y4 survived on exactly that gap).
   */
  const staleNonceDeclared = drain.acknowledge([a], { ...honest(second), nonce: first.receipt.nonce });
  show('correct digest, STALE declared nonce', { acknowledged: staleNonceDeclared.acknowledged.length, why: (staleNonceDeclared.refused[0]?.why ?? '').slice(0, 80) });
  assert.equal(staleNonceDeclared.acknowledged.length, 0, 'the receipt must name THIS send, not merely reproduce its bytes');
  assert.equal(diskRec(a).acknowledgedAt, null);

  const ok = drain.acknowledge([a], honest(second));
  show('the receipt for THIS send, with its channel', { acknowledged: ok.acknowledged.length, by: diskRec(a).acknowledgedBy, evidence: (diskRec(a).acknowledgementEvidence || '').slice(0, 90) });
  assert.equal(ok.acknowledged.length, 1, 'and a genuine, current receipt must still be accepted, or the rule is just broken');
  assert.ok(diskRec(a).acknowledgedAt != null);
});

check('X5 — the bundle carries ONLY lanes that were really handed off (partial drain)', () => {
  /*
   * The reviewer injected a handoff WRITE failure for one lane. That exact
   * injection is not reproducible from a test here: `lanes` is an ESM namespace
   * object and is read-only, so assigning `lanes.restampHandoff` throws
   * ("Cannot assign to read only property") — the same constraint that made the
   * round-4 client probes use network interception. The reviewer reached it by
   * rewriting the module source in a sandbox.
   *
   * So the SAME property is driven through a partial that is reachable in
   * production: one lane whose authoritative file is gone (refused by rule 2)
   * alongside a healthy sibling. The invariant under test is identical — the
   * bundle must contain only what was stamped — and the write-failure variant
   * is covered by mutant `Y5` in `verify-arch-017-mutation.mjs`, which removes
   * the fixpoint loop and is killed by this check.
   */
  const G = 'g-x5';
  const a = lanes.recordDispatch({ label: 'x5a', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, groupId: G }).id;
  const b = lanes.recordDispatch({ label: 'x5b', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, groupId: G }).id;
  lanes.settle(a, { state: 'settled', resultText: 'RESULT-AAA' });
  lanes.settle(b, { state: 'settled', resultText: 'RESULT-BBB' });
  lanes.closeGroup(G, 'x5');
  fs.unlinkSync(diskRec(b).resultPointer);   // b can no longer be sent whole

  const bundle = drain.process([`group:${G}`], { projectId: project.id });
  const bRec = diskRec(b);
  show('partial drain', { sent: bundle.lanes.length, skipped: bundle.skipped.length,
    bundleContainsSkipped: bundle.bundle.includes('RESULT-BBB'), skippedHandoffOnDisk: bRec.handoffAt });
  assert.equal(bundle.lanes.length, 1, 'precondition: exactly one lane was handed over');
  assert.equal(bundle.skipped.length, 1, 'precondition: exactly one was refused');
  assert.equal(bRec.handoffAt, null, 'precondition: the refused lane really has no handoff on disk');
  assert.ok(!bundle.bundle.includes('RESULT-BBB'), 'a result the ledger says was never sent must NOT be inside the bundle the consumer reads');
  assert.ok(bundle.bundle.includes('RESULT-AAA'), 'and the one that WAS sent must be there');
  // finding 1: the response carries no digest, so the holder-computed digest must
  // describe the bundle actually returned (this is what a real consumer checks).
  assert.equal(honestReceipt(bundle).digest, lanes.receiptDigest(bundle.receipt.nonce, bundle.receipt.channel, bundle.bundle),
    'the receipt must describe the bundle that was actually returned, not an earlier candidate set');
  // Every lane NAMED in the bundle must have a handoff; none of the skipped may.
  for (const l of bundle.lanes) assert.ok(diskRec(l.id).handoffAt != null, `${l.id} is in the bundle but has no handoff on disk`);
  for (const sk of bundle.skipped) assert.ok(!bundle.bundle.includes(sk.id), `${sk.id} was skipped but appears in the bundle`);
  const ok = drain.acknowledge([a], honestReceipt(bundle));
  show('the sent lane still acknowledges cleanly', { acknowledged: ok.acknowledged.length });
  assert.equal(ok.acknowledged.length, 1);
});

check('X5b — when the handoff WRITE fails, nothing is reported as sent (the fixpoint)', () => {
  /*
   * The reviewer injected a per-lane write failure by rewriting the module in a
   * sandbox; that is not reachable from here (ESM namespaces are read-only).
   * A write failure that IS reachable in production: the data dir becomes
   * unwritable mid-drain — a full disk, a permissions change, a mount going
   * read-only. Every `restampHandoff` then throws, the candidate set empties,
   * and the drain must report that it sent NOTHING rather than returning a
   * bundle whose lanes have no handoff behind them.
   *
   * This is the check that pins the fixpoint loop (mutant Y6, "keep every
   * candidate in the bundle"): under that mutation the drain returns two lanes
   * and a populated bundle while the ledger records no handoff at all.
   */
  const G = 'g-x5b';
  const a = lanes.recordDispatch({ label: 'x5ba', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, groupId: G }).id;
  const b = lanes.recordDispatch({ label: 'x5bb', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, groupId: G }).id;
  lanes.settle(a, { state: 'settled', resultText: 'RESULT-A5B' });
  lanes.settle(b, { state: 'settled', resultText: 'RESULT-B5B' });
  lanes.closeGroup(G, 'x5b');
  const dir = path.dirname(lanes.laneStoreFile());
  const mode = fs.statSync(dir).mode;
  let out;
  try {
    fs.chmodSync(dir, 0o555);                     // no new files ⇒ writeAtomic fails
    assert.throws(() => lanes.restampHandoff(a, 1, 'probe'), 'precondition: the ledger really is unwritable now');
    out = drain.process([`group:${G}`], { projectId: project.id });
  } finally {
    fs.chmodSync(dir, mode);
  }
  const recs = [diskRec(a), diskRec(b)];
  assert.equal(recs.length, 2, 'precondition: two records, or every assertion below is true of an empty set');
  assert.ok(recs[0] && recs[1], 'precondition: both records must actually exist on disk');
  show('drain against an unwritable ledger', { sent: out.lanes.length, skipped: out.skipped.length, bundleBytes: out.receipt.bytes, bundleEmpty: out.bundle === '' });
  show('on disk', recs.map((r) => ({ id: r.id.slice(-5), handoffAt: r.handoffAt, acknowledgedAt: r.acknowledgedAt })));
  assert.equal(out.lanes.length, 0, 'a drain that stamped nothing must report nothing as sent');
  assert.equal(out.bundle, '', 'and must not return a payload whose lanes have no handoff behind them');
  assert.equal(out.skipped.length, 2, 'both lanes must be named as skipped, with reasons');
  assert.ok(recs.every((r) => r.handoffAt == null), 'nothing may be stamped when the write failed');
  // …and the drain recovers once the ledger is writable again.
  const good = drain.process([`group:${G}`], { projectId: project.id });
  show('after the ledger is writable again', { sent: good.lanes.length, bundleHasBoth: good.bundle.includes('RESULT-A5B') && good.bundle.includes('RESULT-B5B') });
  assert.equal(good.lanes.length, 2, 'the results were held, not lost');
  /*
   * ROUND 7 (cross-provider finding 5): "every lane reported as sent has a
   * handoff on disk" used to loop over `out.lanes` — asserted EMPTY three lines
   * up — so it ran ZERO assertions and proved nothing. The invariant is stated
   * where sent lanes actually EXIST: the recovery drain, whose length is pinned
   * to 2 immediately above, so this loop runs twice and is non-vacuous.
   */
  for (const l of good.lanes) assert.ok(diskRec(l.id).handoffAt != null, `${l.id} reported sent with no handoff on disk`);
});

check('X6 — a MISSING authoritative result file is refused, never silently replaced by its excerpt', () => {
  const G = 'g-x6';
  const a = lanes.recordDispatch({ label: 'x6a', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, groupId: G }).id;
  const long = `HEAD-${'Z'.repeat(4000)}-TAIL`;
  lanes.settle(a, { state: 'settled', resultText: long });
  lanes.closeGroup(G, 'x6');
  const rec0 = diskRec(a);
  assert.ok(rec0.resultExcerpt && rec0.resultExcerpt.length < long.length, 'precondition: the excerpt really is a TRUNCATION of the result');
  fs.unlinkSync(rec0.resultPointer);
  const b = drain.process([`group:${G}`], { projectId: project.id });
  const after = diskRec(a);
  show('drain with the authoritative file deleted', { sent: b.lanes.length, skipped: b.skipped.length,
    bundleBytes: b.receipt.bytes, why: (b.skipped[0]?.why ?? '').slice(0, 90) });
  show('on disk', { handoffAt: after.handoffAt, acknowledgedAt: after.acknowledgedAt, heldReason: (after.heldReason || '').slice(0, 60) });
  assert.equal(b.lanes.length, 0, 'nothing may be delivered when the authoritative bytes are gone');
  assert.equal(b.skipped.length, 1);
  assert.ok(!b.bundle.includes('HEAD-'), 'the excerpt must not be shipped in place of the result');
  assert.equal(after.handoffAt, null, 'and no handoff may be recorded for bytes that were never sent');
  const ack = drain.acknowledge([a], { ...b.receipt, digest: lanes.receiptDigest(b.receipt.nonce, b.receipt.channel, b.bundle) });
  show('an attempt to acknowledge it anyway', { acknowledged: ack.acknowledged.length, why: (ack.refused[0]?.why ?? '').slice(0, 70) });
  assert.equal(ack.acknowledged.length, 0, 'a truncated result recorded as a complete one is the data-integrity lie this refuses');
  assert.equal(diskRec(a).acknowledgedAt, null);
});

check('X7 — held from the review, kept as a regression: deadline close, repeated settlement, nonwriter refusal', () => {
  const G = 'g-x7';
  const now = Date.now();
  lanes.openGroup(G, { closeDeadline: now + 50, members: [
    { label: 'x7a', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, state: 'pending' },
    { label: 'x7b', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, state: 'pending' },
  ] });
  const rows = lanes.list({ groupId: G });
  for (const r of rows) lanes.promotePending(r.id, process.pid, 'tok');
  lanes.settle(rows[0].id, { state: 'settled', resultText: 'RESULT-a' });
  drain.sweep(now + 100);
  const st = lanes.groupState(G);
  show('after the deadline swept', { closed: !st.open, outstandingBeforeLast: st.outstanding });
  assert.equal(st.open, false);
  assert.equal(st.outstanding, 1);
  lanes.settle(rows[1].id, { state: 'settled', resultText: 'RESULT-b' });
  const second = lanes.settle(rows[1].id, { state: 'failed', resultText: 'SHOULD-NOT-REPLACE' });
  show('a repeated settlement', { state: second.state, excerpt: (diskRec(rows[1].id).resultExcerpt || '').slice(0, 20) });
  assert.equal(diskRec(rows[1].id).state, 'settled', 'first settlement wins');
  assert.ok(!(diskRec(rows[1].id).resultExcerpt || '').includes('SHOULD-NOT-REPLACE'));
  const items = drain.pending({ projectId: project.id }).filter((i) => i.groupId === G);
  show('final rail items for the group', items.length);
  assert.equal(items.length, 1, 'the completed group collapses to ONE item');
});

/* ══════ W — the cross-provider reviewer's round-5 probes, made assertions ═══
 *
 * Round 6 encoded those probes as mutants W1-W7 and measured them against the
 * suites as they stood: ALL SEVEN SURVIVED. Every round-5 fix was really in the
 * code and not one of them was asserted by anything — the suites were green
 * around code that could have been reverted wholesale without a check noticing.
 * These are the assertions that close that gap.
 */

check('W1 — a group that has already been DRAINED is sealed, so it cannot be delivered twice', () => {
  /*
   * `groupSeal` has two clauses: closed-at, and drained-at. X1 covers the first
   * (a late joiner cannot re-open a CLOSED group). The second was unasserted,
   * and it is not reachable through a closed group at all — the closed clause
   * fires first, so mutating the drained clause changes nothing there. The
   * reachable shape is an OPEN group with a member already handed over: the
   * rail's advertised "pull a finished lane early" path, which R1 exercises.
   *
   * Admitting a new member to that group would produce a SECOND delivery of a
   * group that has already been delivered once — the double-drain the round-5
   * fix exists to prevent.
   */
  const G = 'g-w1-drained';
  lanes.openGroup(G, { ttlMs: 60 * 60 * 1000, members: [
    { label: 'w1a', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, state: 'pending' },
    { label: 'w1b', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, state: 'pending' },
  ] });
  const rows = lanes.list({ groupId: G }).sort((a, b) => a.id.localeCompare(b.id));
  assert.equal(rows.length, 2, 'precondition: the group really has two declared members');
  for (const r of rows) lanes.promotePending(r.id, process.pid, `tok-${r.id}`);
  lanes.settle(rows[0].id, { state: 'settled', resultText: 'W1 RESULT A' });

  const st0 = lanes.groupState(G);
  show('before the early pull', { open: st0.open, closedAt: st0.closedAt, sealed: st0.sealed });
  assert.equal(st0.sealed, null, 'precondition: an open, undrained group must accept members — or this asserts nothing');
  assert.equal(st0.open, true, 'precondition: the group is still OPEN, so the closed clause cannot be what refuses below');

  const early = drain.process([`lane:${rows[0].id}`], { projectId: project.id });
  assert.equal(early.lanes.length, 1, 'precondition: the early pull really handed one lane over');
  assert.ok(diskRec(rows[0].id).handoffAt != null, 'precondition: and stamped it on disk');

  const st1 = lanes.groupState(G);
  show('after the early pull', { open: st1.open, closedAt: st1.closedAt, sealed: (st1.sealed ?? '').slice(0, 60) });
  assert.equal(st1.closedAt, null, 'the group was never closed — the DRAINED clause is the only thing that can seal it');
  assert.ok(st1.sealed, 'a group with a handed-over member must be sealed against new arrivals');
  assert.match(st1.sealed, /already been drained/, 'and must say why');

  let threw = null;
  try {
    lanes.recordDispatch({ label: 'w1-latecomer', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, groupId: G });
  } catch (e) { threw = e; }
  show('a late member joining an already-drained group', threw ? `REFUSED (${threw.code})` : 'ACCEPTED');
  assert.ok(threw, 'admitting a member to a drained group delivers that group a SECOND time');
  assert.equal(threw.code, 'group-closed');
  const after = disk().filter((r) => r.groupId === G);
  assert.equal(after.length, 2, 'and the latecomer must not be in the ledger at all');
});

check('W9 — CLOSING a delivered group cannot MASK its drained seal, and readiness has ONE answer (round-8 finding 1)', () => {
  /*
   * Round 7 made `groupSeal` one predicate but ordered its kinds so `closed`
   * was checked before `drained`. A fourth cross-provider review walked through
   * it: a group drained, ACKNOWLEDGED, then CLOSED reported `closed` — which
   * `openGroup` treats as the advertised deliberate re-open — so an acknowledged
   * group was re-opened and delivered a SECOND time. The delivered state must be
   * ABSORBING: closing can never overwrite it.
   */
  const G = 'g-w9';
  const a = lanes.recordDispatch({ label: 'w9a', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, groupId: G }).id;
  lanes.settle(a, { state: 'settled', resultText: 'W9 RESULT' });
  lanes.closeGroup(G, 'w9');
  const first = drain.process([`group:${G}`], { projectId: project.id });
  drain.acknowledge([a], honestReceipt(first));
  assert.equal(diskRec(a).acknowledgedAt != null, true, 'precondition: the group was really delivered and acknowledged once');
  const st = lanes.groupState(G);
  show('a delivered-then-closed group', { sealedKind: st.sealedKind, sealed: (st.sealed ?? '').slice(0, 50) });
  assert.equal(st.sealedKind, 'drained', 'the DELIVERED seal must ABSORB the closed one — closing must not mask that the group was handed over');

  let threw = null;
  try { lanes.openGroup(G, { ttlMs: 60_000, members: [{ label: 'w9-reopen', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, state: 'pending' }] }); }
  catch (e) { threw = e; }
  const second = drain.process([`group:${G}`], { projectId: project.id });
  show('re-opening a delivered+closed group', threw ? `REFUSED (${threw.code})` : 'ACCEPTED');
  assert.ok(threw, 'a drained (delivered) group must refuse re-open, even after it was also closed');
  assert.equal(threw.code, 'group-closed');
  assert.equal(second.lanes.length, 0, 'and no second delivery may be produced');
  assert.equal(disk().filter((r) => r.groupId === G).length, 1, 'the re-open member must not reach the ledger');

  /*
   * READINESS HAS ONE ANSWER. An OPEN group with a member early-pulled reads
   * `terminal` from `groupTerminal` (which asks `groupState`) but was rendered
   * as a still-filling LANE item by `pending()` (which re-derived `open`
   * locally) — two answers to one question. Both now go through `groupState`.
   */
  const G2 = 'g-w9-readiness';
  const m = lanes.recordDispatch({ label: 'w9r', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, groupId: G2, groupOpen: true }).id;
  lanes.settle(m, { state: 'settled', resultText: 'W9 readiness' });
  drain.process([`lane:${m}`], { projectId: project.id });
  const term = drain.groupTerminal(G2).terminal;
  const item = drain.pending({ projectId: project.id }).find((i) => i.groupId === G2);
  show('readiness after an early pull', { terminal: term, pendingReady: item?.ready, pendingKind: item?.kind });
  assert.ok(item, 'precondition: the early-pulled, un-acknowledged lane must still be offered on the rail');
  assert.equal(term, item.ready, 'groupTerminal and the rail must give the SAME answer — one predicate, not two');
});

check('W10 — the CLIENT and BROKER hash the SAME bytes, including an EMPTY failure text (round-8 finding 2)', () => {
  /*
   * `dispatch-client.mjs` used `f.text || 'host broker failed'` on the failure
   * branch, so an EMPTY failure text was SUBSTITUTED and hashed, while the broker
   * hashes `frame.text ?? ''` (empty): `2 mismatch ok=false text=""`. The two
   * sides must hash the same bytes. This loads the real `ackAndExit` and compares
   * its receipt digest to `lanes.receiptDigest` (the broker's rule) across ok/not-ok
   * and empty/non-empty/multibyte/delimiter-bearing texts.
   */
  const cs = fs.readFileSync(path.join(ROOT, 'src/server/dispatch-client.mjs'), 'utf8');
  const cc = vm.createContext({ Buffer, crypto: { createHash }, fs: { writeSync: (fd, b, o, n) => (n ?? b.length) }, process: { exit() {} }, setTimeout: () => ({ unref() {} }) });
  vm.runInContext(cs.slice(cs.indexOf('function writeAllSync('), cs.indexOf('function unavailable(')), cc);
  const cases = [];
  for (const ok of [true, false]) for (const text of ['abc', ':12:', '文🙂', '']) {
    let receipt = null;
    cc.ackAndExit({ write(s, cb) { receipt = JSON.parse(s); cb(); }, end() {} }, { ok, text, receiptNonce: 'a'.repeat(32) });
    const expected = lanes.receiptDigest('a'.repeat(32), ok ? 'fd1' : 'fd2', Buffer.from(text, 'utf8'));
    cases.push({ ok, text, matches: receipt.digest === expected });
  }
  const mism = cases.filter((c) => !c.matches);
  show('client-vs-broker digest agreement', { total: cases.length, matched: cases.length - mism.length, mismatches: mism.map((c) => `${c.ok}/${JSON.stringify(c.text)}`) });
  assert.equal(cases.length, 8, 'precondition: all eight ok×text cases ran');
  assert.equal(mism.length, 0, 'every case — including the empty failure text — must hash to what the broker verifies');
});

check('W18 — an overflowing deadline is clamped FINITE (not null-forever), and starvation readiness is MONOTONIC across a clock rollback (round-9 finding 4)', () => {
  const G = 'g-w18-deadline';
  lanes.openGroup(G, { ttlMs: 1000, members: [{ label: 'w18a', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, state: 'pending' }] });
  lanes.extendGroup(G, Number.MAX_VALUE, Number.MAX_VALUE);
  const row = disk().find((r) => r.groupId === G);
  show('extended by MAX_VALUE', { deadline: row.groupCloseDeadline });
  assert.notEqual(row.groupCloseDeadline, null, 'an overflowing deadline must NOT persist as null (JSON drops Infinity), which would leave the group open forever');
  assert.ok(Number.isFinite(row.groupCloseDeadline), `it must be a FINITE number that round-trips; got ${row.groupCloseDeadline}`);

  const G2 = 'g-w18-monotonic';
  const a = lanes.recordDispatch({ label: 'w18-quick', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, groupId: G2, groupOpen: true }).id;
  lanes.recordDispatch({ label: 'w18-slow', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, groupId: G2, groupOpen: true, state: 'pending' });
  lanes.settle(a, { state: 'settled', resultText: 'W18 quick' });
  const settledAt = diskRec(a).settledAt;
  const before = drain.pending({ projectId: project.id, now: settledAt + lanes.HELD_STARVATION_MS, sweepFirst: false }).find((i) => i.laneIds.includes(a));
  assert.ok(before && before.ready === true, 'precondition: past the starvation threshold the held result is READY');
  assert.ok(diskRec(a).starvationReleasedAt != null, 'and the release is PERSISTED on disk, not recomputed from the clock each poll');
  const after = drain.pending({ projectId: project.id, now: settledAt - 3600000, sweepFirst: false }).find((i) => i.laneIds.includes(a));
  show('readiness before/after a 1h clock rollback', { before: before.ready, after: after?.ready });
  assert.ok(after && after.ready === true, 'a released result must STAY ready after the clock rolls back — readiness must not regress');
});

check('W19 — the delivered seal is DURABLE: it survives pruning of the delivered row and refuses reuse of the groupId (round-9 finding 1)', () => {
  const G = 'g-w19-durable';
  const a = lanes.recordDispatch({ label: 'w19a', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, groupId: G }).id;
  lanes.settle(a, { state: 'settled', resultText: 'W19 RESULT' });
  lanes.closeGroup(G, 'w19');
  const first = drain.process([`group:${G}`], { projectId: project.id });
  drain.acknowledge([a], honestReceipt(first));
  assert.equal(diskRec(a).acknowledgedAt != null, true, 'precondition: the group was delivered and acknowledged once');
  assert.ok(lanes.durableGroupSeal(G) != null, 'the seal must be stored DURABLY, not only in the (prunable) rows');

  // Overflow the retention bound with delivered/dismissed rows so the acknowledged row is pruned.
  for (let i = 0; i < 75; i++) {
    const id = lanes.recordDispatch({ label: `w19-fill-${i}`, charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id }).id;
    lanes.settle(id, { state: 'settled', resultText: 'x' });
    lanes.dismiss([id]);
  }
  assert.equal(lanes.get(a), null, 'precondition: the delivered row was pruned away');
  assert.ok(lanes.durableGroupSeal(G) != null, 'and the seal SURVIVED the pruning of every row it named');

  let threw = null;
  try { lanes.recordDispatch({ label: 'w19-late', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, groupId: G }); }
  catch (e) { threw = e; }
  show('late join into a pruned, delivered group', threw ? `REFUSED (${threw.code})` : 'ACCEPTED');
  assert.ok(threw, 'a delivered group whose rows were pruned must STILL refuse new members — the identity is not reusable');
  assert.equal(threw.code, 'group-closed');
});

check('W20 — the drain binds to an immutable record GENERATION; a row swapped underneath is not stamped (round-9 finding 3)', () => {
  const a = lanes.recordDispatch({ label: 'w20a', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id }).id;
  lanes.settle(a, { state: 'settled', resultText: 'W20' });
  const gen = diskRec(a).generation;
  assert.ok(gen, 'precondition: the record carries an immutable generation token');
  lanes.restampHandoff(a, 10, 'evidence-matching-gen', gen);
  assert.ok(diskRec(a).handoffAt != null, 'a handoff whose captured generation matches the row is stamped');
  let threw = null;
  try { lanes.restampHandoff(a, 10, 'evidence-stale-gen', 'A-DIFFERENT-GENERATION'); } catch (e) { threw = e; }
  show('restamp with a stale generation (the row was swapped)', threw ? `REFUSED (${threw.code})` : 'ACCEPTED');
  assert.ok(threw, 'a handoff whose captured generation no longer matches the row on disk must be refused — the bundle was built from a record that no longer exists');
  assert.equal(threw.code, 'conflict');
});

check('W30 — an UNREADABLE seal store FAILS CLOSED (refuse admission); an ABSENT one is legitimately new (round-10 finding 2)', () => {
  const G = 'g-w30';
  const a = lanes.recordDispatch({ label: 'w30a', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, groupId: G }).id;
  lanes.settle(a, { state: 'settled', resultText: 'W30' });
  lanes.closeGroup(G, 'w30');
  const first = drain.process([`group:${G}`], { projectId: project.id });
  drain.acknowledge([a], honestReceipt(first));
  assert.ok(lanes.durableGroupSeal(G) != null, 'precondition: the group is sealed durably');
  fs.writeFileSync(lanes.groupSealFile(), 'not valid json');
  let threw = null;
  try { lanes.recordDispatch({ label: 'w30-new', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, groupId: 'g-w30-fresh' }); }
  catch (e) { threw = e; }
  show('admission with a corrupt seal store', threw ? `REFUSED (${threw.code})` : 'ACCEPTED');
  assert.ok(threw, 'an unreadable seal store must FAIL CLOSED — a durability mechanism that fails open is worse than none');
  assert.equal(threw.code, 'group-closed');
  fs.rmSync(lanes.groupSealFile(), { force: true });
  const ok = lanes.recordDispatch({ label: 'w30-absent-ok', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, groupId: 'g-w30-absent' });
  assert.ok(ok && ok.id, 'an ABSENT seal store is a fresh system and must still admit new groups');
});

check('W31 — a row missing its generation gets a UNIQUE, PERSISTED token, not one derived from the reusable id (round-10 finding 4)', () => {
  const a = lanes.recordDispatch({ label: 'w31a', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id }).id;
  lanes.settle(a, { state: 'settled', resultText: 'W31' });
  const rows = JSON.parse(fs.readFileSync(lanes.laneStoreFile(), 'utf8'));
  delete rows.find((r) => r.id === a).generation;
  fs.writeFileSync(lanes.laneStoreFile(), JSON.stringify(rows));
  const g1 = lanes.get(a).generation;
  show('legacy generation assigned', { generation: g1, derivedFromId: (g1 ?? '').includes(a) });
  assert.ok(g1.length >= 20, `precondition: a real (random) generation token, not empty; got ${JSON.stringify(g1)}`);
  assert.ok(!g1.includes(a), 'a legacy row must get a token NOT derived from its (reusable) id');
  const g2 = lanes.get(a).generation;
  assert.equal(g1, g2, 'the assigned generation is PERSISTED — stable across reads, not re-randomised');
  const onDisk = JSON.parse(fs.readFileSync(lanes.laneStoreFile(), 'utf8')).find((r) => r.id === a);
  assert.equal(onDisk.generation, g1, 'and it is written to disk, not only held in memory');
});

check('W32 — readiness is the PERSISTED release stamp ALONE: not-ready before it, ready after, and stable on re-read (round-10 finding 5)', () => {
  const G = 'g-w32';
  const a = lanes.recordDispatch({ label: 'w32-quick', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, groupId: G, groupOpen: true }).id;
  lanes.recordDispatch({ label: 'w32-slow', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, groupId: G, groupOpen: true, state: 'pending' });
  lanes.settle(a, { state: 'settled', resultText: 'W32' });
  const settledAt = diskRec(a).settledAt;
  const early = drain.pending({ projectId: project.id, now: settledAt + 1, sweepFirst: false }).find((i) => i.laneIds.includes(a));
  assert.ok(early && early.ready === false, 'before the threshold a held result is NOT ready');
  assert.equal(diskRec(a).starvationReleasedAt, null, 'and nothing is stamped');
  const rel = drain.pending({ projectId: project.id, now: settledAt + lanes.HELD_STARVATION_MS, sweepFirst: false }).find((i) => i.laneIds.includes(a));
  assert.ok(rel && rel.ready === true, 'past the threshold it is released and ready');
  assert.ok(diskRec(a).starvationReleasedAt != null, 'and the release is PERSISTED on disk');
  const reread = drain.pending({ projectId: project.id, now: settledAt - 999999, sweepFirst: false }).find((i) => i.laneIds.includes(a));
  show('readiness early / released / re-read at earlier clock', { early: early.ready, released: rel.ready, reread: reread?.ready });
  assert.ok(reread && reread.ready === true, 'a persisted release keeps it ready regardless of the clock — never exposed-and-reversible');
});

check('W33 — the drain RESPONSE never carries the expected digest; echoing it back acknowledges NOTHING (round-11 finding 1)', () => {
  const G = 'g-w33';
  const a = lanes.recordDispatch({ label: 'w33a', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, groupId: G }).id;
  lanes.settle(a, { state: 'settled', resultText: 'W33 PRIVATE RESULT nobody emitted' });
  lanes.closeGroup(G, 'w33');
  const out = drain.process([`group:${G}`], { projectId: project.id });
  assert.equal(out.lanes.length, 1, 'precondition: the lane really was handed over');
  // The response envelope is the CHALLENGE only — never the value acknowledge compares.
  assert.equal(out.receipt.digest, undefined, 'the drain response must NOT include the expected digest (the sender never transmits its own comparison value)');
  assert.ok(out.receipt.nonce && typeof out.receipt.channel === 'string' && Number.isFinite(out.receipt.bytes), 'it still carries the challenge: nonce, channel, bytes');
  // ECHO the whole response receipt verbatim — a consumer that emitted 0 bytes and
  // simply hands the envelope back. With no digest transmitted, there is nothing to
  // echo, so this proves no possession and MUST be refused.
  const echoed = drain.acknowledge([a], { ...out.receipt });
  show('echo the server receipt back verbatim', { acknowledged: echoed.acknowledged.length, why: (echoed.refused[0]?.why ?? '').slice(0, 60) });
  assert.equal(echoed.acknowledged.length, 0, 'echoing the response envelope must acknowledge NOTHING — a proof the verifier handed the prover is not a proof');
  assert.equal(diskRec(a).acknowledgedAt, null, 'and the DISK is unchanged: nothing was collected by an echo');
  // A genuine holder computes the digest OVER THE BYTES it received, and that collects:
  const ok = drain.acknowledge([a], honestReceipt(out));
  show('a receipt computed from the received bytes', { acknowledged: ok.acknowledged.length });
  assert.equal(ok.acknowledged.length, 1, 'a receipt computed from the bytes still collects — the honest path is unbroken');
  assert.ok(diskRec(a).acknowledgedAt != null, 'and now it is acknowledged on disk');
});

check('W34 — a PRESENT-but-malformed seal ENTRY fails CLOSED, not open (round-11 finding 3)', () => {
  const G = 'g-w34';
  // A groupId present in the store but mapped to a non-seal value (`false`) used to
  // read as "unsealed" because `false` is falsy — admitting a late member.
  fs.writeFileSync(lanes.groupSealFile(), JSON.stringify({ [G]: false }));
  const seal = lanes.durableGroupSeal(G);
  show('durableGroupSeal for a malformed (false) entry', seal);
  assert.ok(seal != null, 'a groupId PRESENT but mapped to a non-seal must NOT read as unsealed — a corrupt seal fails closed');
  assert.equal(seal.kind, 'drained', 'fail-closed means "treat as already delivered"');
  let threw = null;
  try { lanes.recordDispatch({ label: 'w34-late', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, groupId: G }); }
  catch (e) { threw = e; }
  show('admission into a group with a malformed seal', threw ? `REFUSED (${threw.code})` : 'ACCEPTED');
  assert.ok(threw && threw.code === 'group-closed', 'admission into a group whose seal is corrupt must be refused, not accepted');
  // an entry that is an object but carries an UNRECOGNISED kind is also corruption:
  fs.writeFileSync(lanes.groupSealFile(), JSON.stringify({ [G]: { at: 1, kind: 'bogus', why: 'x' } }));
  assert.ok(lanes.durableGroupSeal(G) != null, 'an entry with an unrecognised kind is corruption → fail closed');
  // a truly ABSENT groupId remains admissible — fail-closed is per-entry, not global:
  assert.equal(lanes.durableGroupSeal('g-w34-never-sealed'), null, 'a groupId with NO entry is legitimately unsealed');
  fs.rmSync(lanes.groupSealFile(), { force: true });
});

check('W35 — retention never evicts the seal just written; auto ids carry CSPRNG entropy (round-11 finding 4)', () => {
  // Fill the store to the cap with genuinely-OLD seals, then seal a fresh group with
  // a SMALL `at` (a clock rollback, or a caller-supplied small timestamp). The old
  // code evicted the oldest-by-`at`, which was the fresh seal itself.
  const seals = {};
  for (let i = 0; i < lanes.MAX_DURABLE_SEALS; i++) seals['old-' + i] = { at: 1000 + i, kind: 'drained', why: 'old' };
  fs.writeFileSync(lanes.groupSealFile(), JSON.stringify(seals));
  lanes.sealGroupDurably('fresh-but-early', 'drained', 'clock rollback', 1);
  const after = JSON.parse(fs.readFileSync(lanes.groupSealFile(), 'utf8'));
  show('after sealing a fresh group at the cap with a rolled-back clock', { total: Object.keys(after).length, freshPresent: after['fresh-but-early'] != null, oldestDropped: after['old-0'] == null });
  assert.equal(Object.keys(after).length, lanes.MAX_DURABLE_SEALS, 'the store stays bounded at the cap');
  assert.ok(after['fresh-but-early'] != null, 'the seal JUST WRITTEN is RETAINED even with a rolled-back clock — never evict what you just sealed');
  assert.ok(after['old-0'] == null, 'and the genuinely-oldest seal is the one dropped instead');
  fs.rmSync(lanes.groupSealFile(), { force: true });
  // Entropy: the auto-allocated id suffix is CSPRNG hex, not 6 base36 Math.random chars.
  const ids = new Set(); let suffixLen = 0;
  for (let i = 0; i < 200; i++) { const id = lanes.newLaneId(0); ids.add(id); suffixLen = id.split('-').pop().length; }
  show('newLaneId entropy', { suffixLen, distinct: ids.size, sample: lanes.newLaneId(0) });
  assert.ok(suffixLen >= 16, `the random suffix must carry real entropy (>=16 hex chars ≈ 64 bits); got ${suffixLen}`);
  assert.equal(ids.size, 200, 'and 200 auto-allocated ids are all distinct');
});

check('W2 — the receipt comparison is case-insensitive in ONE shared place (an UPPERCASE digest)', () => {
  /*
   * Measured by a cross-provider review: `uppercaseDrainAccepted:1,
   * uppercaseBrokerAccepted:false`. The drain lowercased the incoming digest
   * and the broker compared it raw, so one uppercase receipt was simultaneously
   * valid and invalid depending on the transport. The fix was not to pick a
   * behaviour but to have a single function; this asserts the behaviour AND
   * that the drain path really routes through it.
   */
  const G = 'g-w2-case';
  const a = lanes.recordDispatch({ label: 'w2a', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, groupId: G }).id;
  lanes.settle(a, { state: 'settled', resultText: 'W2 RESULT' });
  lanes.closeGroup(G, 'w2');
  const out = drain.process([`group:${G}`], { projectId: project.id });
  assert.equal(out.lanes.length, 1, 'precondition: one lane was handed over');

  const honest = lanes.receiptDigest(out.receipt.nonce, out.receipt.channel, out.bundle);
  const upper = honest.toUpperCase();
  assert.notEqual(honest, upper, 'precondition: the digest must contain hex letters, or "uppercase" is not a different string');
  show('the shared comparator', { lowerVsUpper: lanes.receiptMatches(honest, upper), lowerVsLower: lanes.receiptMatches(honest, honest) });
  assert.equal(lanes.receiptMatches(honest, upper), true, 'the ONE comparator must accept an uppercase digest');
  assert.equal(lanes.receiptMatches(honest, honest), true, 'and an exact one, or it is simply broken');
  assert.equal(lanes.receiptMatches(honest, honest.slice(0, 32)), false, 'a PREFIX must never match — length is checked');
  assert.equal(lanes.receiptMatches(honest, `${honest.slice(0, 63)}z`), false, 'and a wrong digest of the right length must be refused');

  const ack = drain.acknowledge([a], { ...out.receipt, digest: upper });
  show('an UPPERCASE receipt, end to end', { acknowledged: ack.acknowledged.length, why: (ack.refused[0]?.why ?? '').slice(0, 70) });
  assert.equal(ack.acknowledged.length, 1, 'the drain path must route through the shared comparator, not a second local rule');
  assert.ok(diskRec(a).acknowledgedAt != null, 'and the disk must record the delivery');
});

check('W3 — a channel containing "/" survives the evidence round trip (composer/main)', () => {
  /*
   * Measured by a cross-provider review: `2-free-channel {"channel":
   * "composer/main","acknowledged":0,"expectedParsed":"composer"}` — the
   * receipt facts were pulled back out of the evidence prose with a regex that
   * truncated the channel at the first character outside its class, so a valid
   * receipt was refused because the stored channel had been silently shortened.
   * The fields are JSON now; anything that can hold a `/` can hold whatever the
   * next caller picks.
   */
  const G = 'g-w3-channel';
  const CH = 'composer/main';
  const a = lanes.recordDispatch({ label: 'w3a', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, groupId: G }).id;
  lanes.settle(a, { state: 'settled', resultText: 'W3 RESULT' });
  lanes.closeGroup(G, 'w3');
  const out = drain.process([`group:${G}`], { projectId: project.id, channel: CH });
  assert.equal(out.lanes.length, 1, 'precondition: one lane was handed over');
  assert.equal(out.receipt.channel, CH, 'precondition: the drain must have used the channel it was given');

  const facts = lanes.decodeReceiptFacts(diskRec(a).handoffEvidence);
  show('the channel, recovered from the stored evidence', { stored: facts?.channel, wanted: CH, intact: facts?.channel === CH });
  assert.ok(facts, 'the evidence must decode at all');
  assert.equal(facts.channel, CH, 'the channel must survive the round trip WHOLE — not truncated at the "/"');
  assert.equal(facts.nonce, out.receipt.nonce, 'and so must the nonce');

  const ack = drain.acknowledge([a], { ...out.receipt, digest: lanes.receiptDigest(out.receipt.nonce, CH, out.bundle) });
  show('acknowledging on a slashed channel', { acknowledged: ack.acknowledged.length, why: (ack.refused[0]?.why ?? '').slice(0, 70) });
  assert.equal(ack.acknowledged.length, 1, 'an honest receipt on a free-form channel must be accepted');
  assert.ok(diskRec(a).acknowledgedAt != null);

  /* …and the channel is still BINDING: a truncated one must be refused. */
  const G2 = 'g-w3-channel-2';
  const b = lanes.recordDispatch({ label: 'w3b', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, groupId: G2 }).id;
  lanes.settle(b, { state: 'settled', resultText: 'W3 RESULT B' });
  lanes.closeGroup(G2, 'w3b');
  const out2 = drain.process([`group:${G2}`], { projectId: project.id, channel: CH });
  const truncated = drain.acknowledge([b], { ...out2.receipt, channel: 'composer', digest: lanes.receiptDigest(out2.receipt.nonce, 'composer', out2.bundle) });
  show('the TRUNCATED channel, presented as if it were the real one', { acknowledged: truncated.acknowledged.length });
  assert.equal(truncated.acknowledged.length, 0, 'accepting "composer" for "composer/main" is the original defect with the sign flipped');
  assert.equal(diskRec(b).acknowledgedAt, null, 'and the disk must be unchanged');
});

/* ═══════════════════ H — the remaining hazards, on the real store ══════════ */

function seed(id, over) {
  const rec = lanes.recordDispatch({ label: `seed ${id}`, charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, ...over }, id);
  return rec;
}

check('H1 — HAZARD 3: a group nobody closed is closed by its PERSISTED deadline (sweep)', () => {
  const G = 'g-forgotten';
  lanes.openGroup(G, { ttlMs: 60_000, members: [{ label: 'forgotten a', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, state: 'running' }] });
  const before = lanes.groupState(G);
  show('before the deadline', { open: before.open, deadline: before.closeDeadline != null });
  assert.equal(before.open, true, 'precondition: the group must be open');
  // Scoped to THIS group. The ledger is shared across checks and R3 leaves its
  // own open groups behind, so a global `deepEqual(closed, [G])` was measuring
  // other tests' fixtures — it broke the moment R3 was added, which is the
  // failure mode the E3/E4/E5 scoping fixed earlier in this suite.
  assert.ok(!drain.sweep(Date.now()).closed.includes(G), 'a deadline in the future must not close this group');
  const closed = drain.sweep(Date.now() + 61_000);
  const after = lanes.groupState(G);
  show('after the deadline passed', { closedGroups: closed.closed, thisGroupClosed: closed.closed.includes(G), open: after.open, closedAt: after.closedAt != null });
  assert.ok(closed.closed.includes(G), `the swept set must contain ${G}; got ${JSON.stringify(closed.closed)}`);
  assert.equal(after.open, false, 'a forgotten group must close on its own, or its results are held forever');
  assert.ok(diskRec(disk().find((r) => r.groupId === G).id).groupClosedAt != null, 'the close is PERSISTED, not in-memory');
});

check('H2 — HAZARD 3 across a RESTART: reconcileBoot re-arms from the file, not from a timer', () => {
  const G = 'g-restart-deadline';
  const m = lanes.openGroup(G, { ttlMs: 1000, members: [{ label: 'restart member', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, state: 'pending' }] });
  show('before boot', { open: m.open, outstanding: m.outstanding });
  assert.equal(m.open, true, 'precondition: open');
  // A `setTimeout` would have died with the previous process. The number on the
  // record is what survives, so the boot pass is given a clock past it.
  const s = lanes.reconcileBoot({ now: Date.now() + 5000 });
  const after = lanes.groupState(G);
  const row = disk().find((r) => r.groupId === G);
  show('reconcile summary', { groupsClosedByDeadline: s.groupsClosedByDeadline, cut: s.cut, adopted: s.adopted });
  show('the never-spawned member', { state: row.state, failureKind: row.failureKind });
  assert.ok(s.groupsClosedByDeadline >= 1, 'the boot pass must close groups whose persisted deadline had passed');
  assert.equal(after.open, false);
  assert.equal(row.state, 'cut', 'a member that never spawned must become terminal, not freeze the group');
  assert.equal(row.failureKind, 'never-spawned');
});

check('H3 — a declared member that NEVER SPAWNS does not freeze its group', () => {
  const G = 'g-never-spawn';
  lanes.openGroup(G, {
    ttlMs: 600_000,
    members: [
      { label: 'spawns', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, state: 'pending' },
      { label: 'never spawns', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, state: 'pending' },
    ],
  });
  const rows = lanes.list({ groupId: G });
  assert.equal(rows.length, 2, 'precondition: both declared members must be materialised as rows');
  assert.ok(rows.every((r) => r.state === 'pending'), 'precondition: both start pending');
  const a = rows[0];
  lanes.promotePending(a.id, process.pid, 'tok');
  lanes.settle(a.id, { state: 'settled', resultText: 'the one that ran' });
  show('before close', lanes.groupState(G));
  assert.equal(drain.groupTerminal(G).terminal, false, 'an unspawned member is outstanding, so the group is not terminal');
  lanes.closeGroup(G, 'test close');
  const t = drain.groupTerminal(G);
  const ghost = lanes.list({ groupId: G }).find((r) => r.id !== a.id);
  show('after close', { terminal: t.terminal, ghostState: ghost.state, ghostKind: ghost.failureKind, ghostReason: (ghost.heldReason || '').slice(0, 90) });
  assert.equal(t.terminal, true, 'closing resolves the unspawned member so the group can drain');
  assert.equal(ghost.state, 'cut');
  assert.equal(ghost.failureKind, 'never-spawned');
  const items = drain.pending({ projectId: project.id }).filter((i) => i.groupId === G);
  show('rail items for this group', items.map((i) => ({ id: i.id, lanes: i.laneIds.length, ready: i.ready })));
  assert.equal(items.length, 1, 'one item for the group');
  assert.equal(items[0].ready, true);
});

check('H4 — HAZARD 4: a held result is RELEASED on its own rather than starved by a slow sibling', () => {
  const G = 'g-starve';
  lanes.openGroup(G, { ttlMs: 60 * 60 * 1000, members: [
    { label: 'quick', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, state: 'pending' },
    { label: 'endless', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, state: 'pending' },
  ] });
  const rows = lanes.list({ groupId: G });
  lanes.promotePending(rows[0].id, process.pid, 'tok');
  lanes.promotePending(rows[1].id, process.pid, 'tok');
  const quick = lanes.settle(rows[0].id, { state: 'settled', resultText: 'quick result' });
  const now = Date.now();
  const soon = drain.pending({ projectId: project.id, now, sweepFirst: false }).filter((i) => i.groupId === G);
  show('immediately after it settles', soon.map((i) => ({ ready: i.ready, waitingOn: i.waitingOn })));
  assert.equal(soon.length, 1);
  assert.equal(soon[0].ready, false, 'precondition: it is NOT released while it is fresh');
  const later = drain.pending({ projectId: project.id, now: (quick.settledAt ?? now) + lanes.HELD_STARVATION_MS + 1000, sweepFirst: false }).filter((i) => i.groupId === G);
  show(`after ${lanes.HELD_STARVATION_MS / 60000} minutes of waiting`, later.map((i) => ({ ready: i.ready, reason: i.reason.slice(0, 80) })));
  assert.equal(later[0].ready, true, 'one slow lane must not hold a finished result hostage indefinitely');
  assert.match(later[0].reason, /released on its own/);
});

check('H5 — HAZARD 1: a lane settling has NO channel to interrupt a turn; delivery is pull-only', () => {
  // The structural claim, asserted on the real module surface rather than
  // asserted in prose: nothing in the drain can push, and a background settle
  // writes the ledger and returns.
  const exported = Object.keys(drain);
  show('lane-drain exports', exported);
  assert.ok(exported.length >= 5, `precondition: the module must really export its surface; got ${JSON.stringify(exported)}`);
  assert.deepEqual(exported.filter((k) => /notify|push|send|wake|emit|interrupt/i.test(k)), [], 'the drain must have no push path at all');
  const G = 'g-midturn';
  lanes.openGroup(G, { ttlMs: 60_000, members: [{ label: 'mid-turn', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, state: 'pending' }] });
  const r = lanes.list({ groupId: G })[0];
  lanes.promotePending(r.id, process.pid, 'tok');
  const settled = lanes.settle(r.id, { state: 'settled', resultText: 'landed while the orchestrator was busy' });
  const rec = diskRec(r.id);
  show('the record a mid-turn settle produced', { state: rec.state, handoff: rec.handoffAt, acknowledged: rec.acknowledgedAt, resultOnDisk: fs.existsSync(rec.resultPointer) });
  assert.equal(settled.state, 'settled');
  assert.equal(rec.handoffAt, null, 'settling must not hand anything anywhere — that is what makes a mid-turn settle harmless');
  assert.equal(rec.acknowledgedAt, null);
  assert.ok(fs.existsSync(rec.resultPointer), 'and the result is durable, so the turn can collect it whenever it likes');
});

check('H6 — a corrupt ledger refuses the WHOLE rail rather than showing a comfortable partial list', () => {
  const keep = fs.readFileSync(lanes.laneStoreFile(), 'utf8');
  const good = JSON.parse(keep);
  assert.ok(good.length > 1, 'precondition: the ledger must have several records');
  fs.writeFileSync(lanes.laneStoreFile(), JSON.stringify([...good, { id: 'bad', acknowledgedAt: 'garbage' }]));
  let refused = null;
  try { drain.pending({ projectId: project.id }); } catch (e) { refused = e.message.slice(0, 120); }
  show('the rail asked a corrupt ledger', refused);
  assert.ok(refused, 'one bad record must refuse the whole read — a partial list would be rewritten over the unparsed record by the next write');
  fs.writeFileSync(lanes.laneStoreFile(), keep);
  assert.ok(Array.isArray(drain.pending({ projectId: project.id })), 'and it recovers once the file is repaired');
});

/* ═══════════════════════════ must-FAIL proof legs ══════════════════════════ */

mustFail('leg 1: draining an OPEN group would deliver a partial fan-out; the shipped rule refuses', () => {
  const G = 'mf-open';
  lanes.openGroup(G, { ttlMs: 60_000, members: [{ label: 'a', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, state: 'pending' }] });
  const r = lanes.list({ groupId: G })[0];
  lanes.promotePending(r.id, process.pid, 'tok');
  lanes.settle(r.id, { state: 'settled', resultText: 'x' });
  // The NAIVE rule a drain would naturally be written with: "every member I can
  // see is terminal, so fire". Every member IS terminal here.
  const rows = lanes.list({ groupId: G });
  assert.equal(rows.length, 1, `precondition: the group must have exactly one member for the naive rule below to mean anything; got ${rows.length}`);
  const naive = rows.every((x) => x.state !== 'running' && x.state !== 'pending');
  const shipped = drain.groupTerminal(G).terminal;
  show('naive rule (all visible members terminal)', naive ? 'WOULD DRAIN' : 'would not');
  show('shipped rule', shipped ? 'DRAINS' : 'REFUSES — the group is still open');
  assert.equal(naive, true, 'precondition: the naive rule really would fire here, or this leg proves nothing');
  assert.equal(shipped, false);
  const items = drain.pending({ projectId: project.id }).filter((i) => i.groupId === G);
  assert.ok(items.length >= 1, `precondition: the open group must offer at least one item, or "they are all lane items" is vacuous; got ${items.length}`);
  assert.ok(items.every((i) => i.kind === 'lane'), 'and it does not collapse to a group item either');
});

mustFail('leg 2: acknowledging on a forged/absent possession proof; the shipped rule leaves it HELD', () => {
  const G = 'mf-forge';
  lanes.openGroup(G, { ttlMs: 60_000, members: [{ label: 'a', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, state: 'pending' }] });
  const r = lanes.list({ groupId: G })[0];
  lanes.promotePending(r.id, process.pid, 'tok');
  lanes.settle(r.id, { state: 'settled', resultText: 'secret payload' });
  lanes.closeGroup(G, 'mf');
  const b = drain.process([`group:${G}`], { projectId: project.id });
  assert.ok(b.lanes.length === 1, 'precondition: one lane was handed over');
  for (const bad of [null, { bytes: b.receipt.bytes, digest: 'not-a-digest' }, { bytes: b.receipt.bytes, digest: '0'.repeat(64) }, { bytes: NaN, digest: honestReceipt(b).digest }]) {
    const out = drain.acknowledge([r.id], bad);
    show(`receipt ${JSON.stringify(bad)?.slice(0, 50)}`, { acknowledged: out.acknowledged.length, why: out.refused[0]?.why?.slice(0, 70) });
    assert.equal(out.acknowledged.length, 0, 'a receipt nobody could produce from the bytes must not acknowledge anything');
    assert.equal(diskRec(r.id).acknowledgedAt, null);
  }
  const ok = drain.acknowledge([r.id], honestReceipt(b));
  show('and the REAL receipt', { acknowledged: ok.acknowledged.length });
  assert.equal(ok.acknowledged.length, 1, 'the gate must still accept a genuine receipt, or it is just broken');
});

mustFail('leg 6: ECHOING the response envelope would acknowledge a result nobody emitted (round-11 finding 1)', () => {
  const G = 'mf-echo';
  lanes.openGroup(G, { ttlMs: 60_000, members: [{ label: 'a', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, state: 'pending' }] });
  const r = lanes.list({ groupId: G })[0];
  lanes.promotePending(r.id, process.pid, 'tok');
  lanes.settle(r.id, { state: 'settled', resultText: 'secret nobody emitted' });
  lanes.closeGroup(G, 'mf');
  const out = drain.process([`group:${G}`], { projectId: project.id });
  // The OLD design returned `receipt.digest`; a consumer that echoed the whole
  // envelope back would acknowledge without emitting a byte. Reproduce that world:
  const leakyEnvelope = { ...out.receipt, digest: honestReceipt(out).digest }; // what the old response WOULD have carried
  const echoedOld = drain.acknowledge([r.id], leakyEnvelope);
  show('if the response leaked its digest, echoing it', { acknowledged: echoedOld.acknowledged.length });
  assert.equal(echoedOld.acknowledged.length, 1, 'MUST-FAIL: with the digest in hand (as the old response gave it) the echo DOES acknowledge — this is the defect');
  // …but the SHIPPED response does not carry it, so the honest-only path is what remains:
  assert.equal(out.receipt.digest, undefined, 'the shipped response withholds the digest, so no consumer can echo it');
});

mustFail('leg 7: a malformed seal entry would admit a late member; a rolled-back retention would evict a fresh seal (round-11 findings 3/4)', () => {
  fs.writeFileSync(lanes.groupSealFile(), JSON.stringify({ 'g-mf7': false }));
  // Naive rule: `seals[groupId]` truthiness ⇒ a `false` entry reads as unsealed.
  const naiveUnsealed = !(JSON.parse(fs.readFileSync(lanes.groupSealFile(), 'utf8'))['g-mf7']);
  show('naive truthiness rule on a false entry', { readsAsUnsealed: naiveUnsealed });
  assert.ok(naiveUnsealed, 'MUST-FAIL: the naive truthiness rule reads a malformed entry as unsealed — the defect');
  assert.ok(lanes.durableGroupSeal('g-mf7') != null, 'the shipped rule fails closed instead');
  fs.rmSync(lanes.groupSealFile(), { force: true });
});

mustFail('leg 3: a member declared but never spawned would freeze its group forever', () => {
  const G = 'mf-ghost';
  lanes.openGroup(G, { ttlMs: 60_000, members: [
    { label: 'ran', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, state: 'pending' },
    { label: 'never ran', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, state: 'pending' },
  ] });
  const rows = lanes.list({ groupId: G });
  lanes.promotePending(rows[0].id, process.pid, 'tok');
  lanes.settle(rows[0].id, { state: 'settled', resultText: 'x' });
  const frozen = drain.groupTerminal(G);
  // The precondition that matters is the GHOST, not the openness: the group is
  // also open here, so assert on `outstanding` — the ghost is counted as a
  // member still to come, which is what would freeze the drain forever once the
  // group closes, because nothing will ever promote or settle it.
  show('with the ghost still pending', { terminal: frozen.terminal, outstanding: frozen.state.outstanding, ghostIsOutstanding: frozen.state.outstanding === 1 });
  assert.equal(frozen.state.outstanding, 1, 'precondition: the unspawned ghost is counted as a member still to come');
  assert.equal(frozen.terminal, false, 'precondition: the ghost really does block the group');
  lanes.closeGroup(G, 'mf');
  const after = drain.groupTerminal(G);
  const ghost = lanes.list({ groupId: G }).find((x) => x.id !== rows[0].id);
  show('after the close resolves it', { terminal: after.terminal, ghost: { state: ghost.state, failureKind: ghost.failureKind } });
  assert.equal(after.terminal, true, 'the shipped rule converts the ghost to a terminal, visible outcome');
});

mustFail('leg 4: adopting a live orphan without proof; the shipped rule demands the argv token', () => {
  const all = JSON.parse(fs.readFileSync(lanes.laneStoreFile(), 'utf8'));
  const tpl = all[0];
  all.push({ ...tpl, id: 'mf-orphan', state: 'running', settledAt: null, failureKind: null, acknowledgedAt: null, handoffAt: null, dismissedAt: null, reconciledAt: null, reconcileDetail: null, pid: process.pid, argvToken: 'a-token-this-process-does-not-carry', serverPid: 999998, serverStart: '1', bootId: 'gone' });
  fs.writeFileSync(lanes.laneStoreFile(), JSON.stringify(all));
  // The naive rule: "the pid is alive, so adopt it." This pid IS alive — it is
  // us — so the naive rule fires and adopts a lane that is not ours at all.
  const naiveAlive = (() => { try { process.kill(process.pid, 0); return true; } catch { return false; } })();
  const s = lanes.reconcileBoot();
  const rec = JSON.parse(fs.readFileSync(lanes.laneStoreFile(), 'utf8')).find((r) => r.id === 'mf-orphan');
  show('naive rule (pid is alive ⇒ adopt)', naiveAlive ? 'WOULD ADOPT' : 'would not');
  show('shipped rule', { state: rec.state, failureKind: rec.failureKind, adopted: s.adopted });
  assert.equal(naiveAlive, true, 'precondition: the naive rule really would fire');
  assert.equal(rec.state, 'cut', 'no token match ⇒ no adoption');
  assert.equal(rec.failureKind, 'server-restart');
});

mustFail('leg 5: a starving held result would wait on its sibling forever without the age bound', () => {
  const G = 'mf-starve';
  lanes.openGroup(G, { ttlMs: 24 * 60 * 60 * 1000, members: [
    { label: 'fast', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, state: 'pending' },
    { label: 'endless', charter: 'c', provider: 'openai', transport: 'blocking-dispatch', projectId: project.id, state: 'pending' },
  ] });
  const rows = lanes.list({ groupId: G });
  lanes.promotePending(rows[0].id, process.pid, 'tok');
  lanes.promotePending(rows[1].id, process.pid, 'tok');
  const fast = lanes.settle(rows[0].id, { state: 'settled', resultText: 'x' });
  const base = fast.settledAt;
  // Without the bound, `ready` is purely "is the group terminal?", which this
  // group never becomes — the endless sibling never settles.
  const naive = drain.groupTerminal(G).terminal;
  const day = drain.pending({ projectId: project.id, now: base + 24 * 60 * 60 * 1000, sweepFirst: false }).filter((i) => i.groupId === G);
  show('group-terminal rule, a DAY later', naive ? 'terminal' : 'STILL NOT TERMINAL — the naive rule never releases this');
  show('shipped rule, a day later', day.map((i) => ({ ready: i.ready, reason: i.reason.slice(0, 70) })));
  assert.equal(naive, false, 'precondition: the group really never becomes terminal');
  assert.equal(day[0].ready, true);
});

await broker.stop(project);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* scratch */ }
console.log(`\nRESULT ${pass} PASS / ${fail} FAIL${ONLY_MUST_FAIL ? '  (must-FAIL legs only)' : ''}`);
process.exit(fail ? 1 : 0);
