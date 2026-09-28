#!/usr/bin/env node
/**
 * BUG-190 — unit arm for scripts/lib/host-admission.mjs `startWhenAdmitted`.
 *
 * Contract:
 *   - retry ONLY the structured transient admission refusal
 *     (`code: 'runtime-check-pending'`); message text is never a signal;
 *   - any other error that precedes the start's `session-init` fails LOUDLY
 *     (throws) without a retry, whatever its order relative to a refusal;
 *   - the outcome is decided by ORDER in one event stream, never by "no error
 *     seen during a sleep" (round 4);
 *   - a start that never initialises, or is refused on every attempt, throws.
 *
 * Pinned baselines (so the must-FAIL proofs cannot drift with the tree): the
 * round-1 helper (verify run 01a0e30f) and the round-3 helper (verify run
 * 01a0e4e1, the settle-sleep boundary), both verbatim.
 *
 * No server, no network: scripted fake sockets.
 */
import { startWhenAdmitted } from './lib/host-admission.mjs';

let pass = 0, fail = 0;
const check = (name, ok, observed) => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  console.log(`        observed: ${JSON.stringify(observed)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The round-1 helper, pinned verbatim. */
async function round1StartWhenAdmitted(openWs, port, startMsg, { attempts = 40, initMs = 90_000 } = {}) {
  const TRANSIENT = /runtime check pending|checking runtime/;
  let c = null;
  for (let i = 0; i < attempts; i++) {
    c = await openWs(port);
    c.send(startMsg);
    const t0 = Date.now();
    let outcome = null;
    while (Date.now() - t0 < initMs && !outcome) {
      const init = c.events.find((e) => e.t === 'session-init');
      if (init) outcome = { init };
      else if (c.events.some((e) => e.t === 'error' && TRANSIENT.test(e.message ?? ''))) outcome = 'retry';
      else await new Promise((r) => setTimeout(r, 150));
    }
    if (outcome === 'retry') { try { c.ws.close(); } catch { /* closed */ } await new Promise((r) => setTimeout(r, 10)); continue; }
    return { c, init: outcome?.init ?? null };
  }
  return { c, init: null };
}

/** The round-3 helper, pinned verbatim (socket per retry + settle sleep). */
async function round3StartWhenAdmitted(openWs, port, startMsg, { attempts = 40, initMs = 90_000, retryMs = 1000 } = {}) {
  const isAdmission = (e) => e?.t === 'error' && e.code === 'runtime-check-pending';
  const sockets = [];
  const tail = (c) => JSON.stringify(c?.events?.slice(-4) ?? []);
  const closeAll = () => { for (const s of sockets) { try { s.ws.close(); } catch { /* closed */ } } };
  const foreign = () => {
    for (const s of sockets) {
      const e = s.events.find((x) => x.t === 'error' && !isAdmission(x));
      if (e) return { s, e };
    }
    return null;
  };
  const fail = (why, c) => { closeAll(); return new Error(`${why} — last events ${tail(c)}`); };
  const pause = async (ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const f = foreign();
      if (f) throw fail(`start failed with a non-admission error (not retried): ${f.e.message ?? JSON.stringify(f.e)}`, f.s);
      await new Promise((r) => setTimeout(r, Math.min(25, ms)));
    }
  };
  for (let i = 0; i < attempts; i++) {
    const c = await openWs(port);
    sockets.push(c);
    c.send(startMsg);
    const t0 = Date.now();
    for (;;) {
      const f = foreign();
      if (f) throw fail(`start failed with a non-admission error (not retried): ${f.e.message ?? JSON.stringify(f.e)}`, f.s);
      if (c.events.some(isAdmission)) break;
      const init = c.events.find((e) => e.t === 'session-init');
      if (init) {
        await pause(Math.min(retryMs, 100));
        for (const s of sockets) if (s !== c) { try { s.ws.close(); } catch { /* closed */ } }
        return { c, init };
      }
      if (Date.now() - t0 >= initMs) throw fail(`start never initialised within ${initMs} ms`, c);
      await new Promise((r) => setTimeout(r, 25));
    }
    await pause(retryMs);
  }
  throw fail(`start still refused by the boot runtime check after ${attempts} attempts`, sockets.at(-1));
}

/**
 * A fake server connection. `plan[k]` is what the server answers to the k-th
 * `start` sent on a socket: an array of events, each optionally delayed
 * (`{ after: ms, e: event }`). Every openWs() gets its own socket and its own
 * send counter (a real refused socket accepts another start — index.ts clears
 * `starting` and never binds a session on a refusal).
 */
function fakeServer(plan) {
  const s = { opens: 0, sends: 0 };
  s.openWs = async () => {
    s.opens++;
    const events = [];
    let n = 0;
    return {
      events,
      send() {
        const answer = plan[Math.min(n, plan.length - 1)] ?? [];
        n++; s.sends++;
        for (const item of answer) {
          if (item && item.after != null) setTimeout(() => events.push(item.e), item.after);
          else events.push(item);
        }
      },
      ws: { close() {} },
    };
  };
  return s;
}
const PENDING = { t: 'error', message: 'runtime check pending — Orchard is verifying the bundled runtime', fatal: true, code: 'runtime-check-pending' };
const INIT = { t: 'session-init', sessionId: 'sid-ok' };
const PERM = { t: 'error', message: 'permission denied', fatal: true };

async function outcome(fn, s) {
  try {
    const r = await fn();
    return { returned: true, init: r?.init ?? null, threw: null, opens: s.opens, sends: s.sends };
  } catch (err) {
    return { returned: false, init: null, threw: String(err.message).slice(0, 120), opens: s.opens, sends: s.sends };
  }
}
const OPTS = { attempts: 3, initMs: 400, retryMs: 50 };

async function main() {
  console.log('\n=== pinned baselines (the defects the arms below must catch) ===');
  {
    // Round 1 opened a socket per attempt: the Nth socket carries script[N].
    const script = [[{ t: 'error', message: 'permission denied', fatal: true }, { t: 'error', message: 'runtime check pending' }], [INIT]];
    const s = { opens: 0, sends: 0 };
    s.openWs = async () => { const events = [...script[Math.min(s.opens, 1)]]; s.opens++; return { events, send() { s.sends++; }, ws: { close() {} } }; };
    const o = await outcome(() => round1StartWhenAdmitted(s.openWs, 0, { type: 'start' }, OPTS), s);
    check('BASELINE r1: the round-1 helper retries past a fatal error and reports SUCCESS', o.returned && o.init?.sessionId === 'sid-ok', o);
  }
  {
    // The verifier's round-4 boundary: the refused socket's fatal lands 95 ms
    // after the retry socket's init — inside the round-3 settle's final sleep.
    let opens = 0; const first = [];
    const openWs = async () => {
      const n = ++opens; const events = n === 1 ? first : [];
      return { events, ws: { close() {} }, send() {
        if (n === 1) { events.push(PENDING); return; }
        events.push(INIT);
        setTimeout(() => first.push(PERM), 95);
      } };
    };
    let returned = false;
    try { await round3StartWhenAdmitted(openWs, 0, { type: 'start' }, { retryMs: 100, initMs: 300, attempts: 3 }); returned = true; } catch { /* threw */ }
    check('BASELINE r3: the round-3 helper resolves SUCCESS with a permission error landing in its settle sleep', returned, { returned, first });
  }

  console.log('\n=== the helper as it stands ===');
  {
    const s = fakeServer([[PERM, PENDING], [INIT]]);
    const o = await outcome(() => startWhenAdmitted(s.openWs, 0, { type: 'start' }, OPTS), s);
    check('A1: a fatal error alongside the refusal THROWS without a retry', !o.returned && /permission denied/.test(o.threw ?? '') && o.sends === 1, o);
  }
  {
    const s = fakeServer([[PENDING, { t: 'error', message: 'REFUSING to create a session: store not isolated', fatal: true }], [INIT]]);
    const o = await outcome(() => startWhenAdmitted(s.openWs, 0, { type: 'start' }, OPTS), s);
    check('A2: refusal FIRST, fatal after it — still throws, no retry', !o.returned && /store not isolated/.test(o.threw ?? '') && o.sends === 1, o);
  }
  {
    const s = fakeServer([[{ t: 'error', message: 'this session is still finishing its previous turn', fatal: false, retryable: true }], [INIT]]);
    const o = await outcome(() => startWhenAdmitted(s.openWs, 0, { type: 'start' }, OPTS), s);
    check('A3: a NON-fatal, non-admission error throws, no retry', !o.returned && /still finishing/.test(o.threw ?? '') && o.sends === 1, o);
  }
  {
    const s = fakeServer([[PENDING], [{ t: 'error', message: 'checking runtime — the bundled runtime changed on disk', fatal: true, code: 'runtime-check-pending' }], [INIT]]);
    const o = await outcome(() => startWhenAdmitted(s.openWs, 0, { type: 'start' }, OPTS), s);
    check('A4: the coded refusal (both wordings) is retried — on the SAME socket — and a later clean start succeeds',
      o.returned && o.init?.sessionId === 'sid-ok' && o.sends === 3 && o.opens === 1, o);
  }
  {
    const s = fakeServer([[INIT]]);
    const o = await outcome(() => startWhenAdmitted(s.openWs, 0, { type: 'start' }, OPTS), s);
    check('A5: a start admitted first time returns its session-init', o.returned && o.init?.sessionId === 'sid-ok' && o.sends === 1, o);
  }
  {
    const s = fakeServer([[{ t: 'status', status: 'starting' }]]);
    const o = await outcome(() => startWhenAdmitted(s.openWs, 0, { type: 'start' }, OPTS), s);
    check('A6: a start that never initialises within initMs THROWS', !o.returned && /never initialised/.test(o.threw ?? ''), o);
  }
  {
    const s = fakeServer([[PENDING]]);
    const o = await outcome(() => startWhenAdmitted(s.openWs, 0, { type: 'start' }, OPTS), s);
    check('A7: refused on EVERY attempt THROWS after exactly `attempts` sends', !o.returned && /after 3 attempts/.test(o.threw ?? '') && o.sends === 3, o);
  }
  {
    const s = fakeServer([[PENDING, { after: 10, e: PERM }], [INIT]]);
    const o = await outcome(() => startWhenAdmitted(s.openWs, 0, { type: 'start' }, { attempts: 3, retryMs: 100, initMs: 400 }), s);
    check('A8: a fatal error landing DURING the retry delay throws, and no retry is sent', !o.returned && /permission denied/.test(o.threw ?? '') && o.sends === 1, o);
  }
  {
    const s = fakeServer([[{ t: 'error', message: 'EACCES: permission denied while checking runtime executable', fatal: true }], [INIT]]);
    const o = await outcome(() => startWhenAdmitted(s.openWs, 0, { type: 'start' }, OPTS), s);
    check('A9: an uncoded fatal whose TEXT contains "checking runtime" throws, no retry', !o.returned && /EACCES/.test(o.threw ?? '') && o.sends === 1, o);
  }
  {
    const s = fakeServer([[{ t: 'error', message: 'runtime check pending — Orchard is verifying the bundled runtime', fatal: true }], [INIT]]);
    const o = await outcome(() => startWhenAdmitted(s.openWs, 0, { type: 'start' }, OPTS), s);
    check('A10: the admission WORDING without the code is not trusted — throws', !o.returned && o.sends === 1, o);
  }
  {
    const s = fakeServer([[{ ...PENDING, code: 'runtime-check-failed' }], [INIT]]);
    const o = await outcome(() => startWhenAdmitted(s.openWs, 0, { type: 'start' }, OPTS), s);
    check('A11: a PERMANENT runtime refusal is not retried — throws', !o.returned && o.sends === 1, o);
  }

  console.log('\n=== round 4 (verifier run 01a0e4e1): decided by stream ORDER, not by a sleep ===');
  {
    // The verifier's boundary scenario, run against the helper as it stands.
    let opens = 0; const first = [];
    const openWs = async () => {
      const n = ++opens; const events = n === 1 ? first : [];
      return { events, ws: { close() {} }, send() {
        if (n === 1) { events.push(PENDING); return; }
        events.push(INIT);
        setTimeout(() => first.push(PERM), 95);
      } };
    };
    let returned = false, threw = null;
    try { await startWhenAdmitted(openWs, 0, { type: 'start' }, { retryMs: 100, initMs: 300, attempts: 3 }); returned = true; } catch (e) { threw = e.message.slice(0, 80); }
    check('A12 (fails pre-fix): the verifier\'s settle-boundary scenario never resolves SUCCESS', !returned, { returned, threw, opens });
  }
  for (const gap of [0, 20, 49, 50, 51, 95, 99, 100, 101, 150]) {
    // Sweep the fatal's arrival across every point of the old settle window: on
    // the retried start, the fatal lands `gap` ms BEFORE the session-init.
    const s = fakeServer([[PENDING], [{ after: 200, e: PERM }, { after: 200 + gap + 1, e: INIT }]]);
    const o = await outcome(() => startWhenAdmitted(s.openWs, 0, { type: 'start' }, { attempts: 3, retryMs: 50, initMs: 2000 }), s);
    check(`A13: a fatal that PRECEDES the session-init in the stream throws (fatal ${gap + 1} ms before init)`, !o.returned && /permission denied/.test(o.threw ?? ''), o);
  }
  {
    const s = fakeServer([[PENDING], [INIT, { after: 30, e: PERM }]]);
    const o = await outcome(() => startWhenAdmitted(s.openWs, 0, { type: 'start' }, OPTS), s);
    check('A14: the start is decided at its session-init — a later error belongs to the running session, not the start', o.returned && o.init?.sessionId === 'sid-ok', o);
  }
  {
    // Sanity on timing: resolution is immediate on the definitive signal, not after a settle sleep.
    const s = fakeServer([[INIT]]);
    const t0 = Date.now();
    const o = await outcome(() => startWhenAdmitted(s.openWs, 0, { type: 'start' }, { attempts: 3, retryMs: 5000, initMs: 400 }), s);
    const ms = Date.now() - t0;
    check('A15: success resolves on the session-init itself (no settle sleep; retryMs 5 s is never spent)', o.returned && ms < 500, { ...o, ms });
  }

  console.log(`\n${pass}/${pass + fail} checks passed`);
  process.exitCode = fail ? 1 : 0;
}
main().catch((err) => { console.error(`FATAL: ${err.stack ?? err.message}`); process.exitCode = 1; });
