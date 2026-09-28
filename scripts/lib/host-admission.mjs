/**
 * Deterministic readiness for the FEAT-151 boot runtime check — a real signal to
 * wait on instead of a fixed sleep.
 *
 * A freshly-booted server answers /api/health BEFORE its one-time boot runtime
 * check (`claude --version` + a content hash of the bundled binary) completes,
 * and until it does every new DIRECT host session start — a fresh start OR a
 * resume, both go through `startSession`'s `hostSessionBlockReason()` guard — is
 * refused fail-closed with "runtime check pending". `host.restartPending` on GET
 * /api/runtime/version is exactly `admission().blocked`: true while the boot
 * check is pending, false once it has passed against a matching on-disk runtime
 * (no update in flight, as in every scratch run). Poll it so a suite waits out
 * the boot check on the server's OWN readiness signal rather than a fixed sleep.
 *
 * Returns true once ready; false on timeout (the caller decides whether that is
 * fatal). `startWhenAdmitted` handles the same window reactively for a plain
 * start; this is for callers that must fire a non-`start` frame (e.g. a racing
 * resume whose ack/error is the thing under test) only once admission is open.
 *
 * @param {number} port
 * @param {{ ms?: number, host?: string }} [opts]
 * @returns {Promise<boolean>}
 */
export async function waitRuntimeReady(port, { ms = 30_000, host = '127.0.0.1' } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`http://${host}:${port}/api/runtime/version`);
      if (r.ok) {
        const j = await r.json();
        if (j?.host && j.host.restartPending === false) return true;
      }
    } catch { /* server not answering yet */ }
    await new Promise((res) => setTimeout(res, 150));
  }
  return false;
}

/**
 * Start a host session on a freshly booted scratch server, waiting out the
 * FEAT-151 boot runtime check.
 *
 * A fresh server answers /api/health before its one-time boot runtime check
 * (`claude --version` + a content hash of the bundled binary) has completed, and
 * until it completes every new DIRECT host session is refused, fail-closed, with
 * "runtime check pending — …" (runtime-update.ts `admission()`). That is intended
 * product behaviour, so a suite that seeds a session straight after the health
 * check races it and dies in setup with "session never initialised / seed turn
 * never started". This retries on EXACTLY that transient refusal (and its
 * "checking runtime" sibling) and nothing else: any other error, or a start that
 * never initialises, THROWS (BUG-190 round 2: it used to retry past a fatal
 * non-admission error and could then report success). Round 3: the refusal is
 * recognised ONLY by its structured `code: 'runtime-check-pending'`. Round 4:
 * one socket, and the outcome is decided by event ORDER, not by a settle sleep. Same rule as
 * scripts/lib/bug-187-harness.mjs `startFakeSession`.
 *
 * @param {(port:number)=>Promise<{ws:any,events:any[],send:(o:any)=>void}>} openWs
 * @param {number} port
 * @param {object} startMsg  the `{ type: 'start', … }` frame
 * @param {{ attempts?: number, initMs?: number }} [opts]
 * @returns {Promise<{ c: any, init: any }>} the socket and its session-init event
 * @throws {Error} on any error event other than the admission refusal, on no
 *   session-init within `initMs`, or when every attempt was refused
 */
export async function startWhenAdmitted(openWs, port, startMsg, { attempts = 40, initMs = 90_000, retryMs = 1000 } = {}) {
  // BUG-190 round 3: the ONLY retryable signal is the server's structured code
  // (events.ts `code: 'runtime-check-pending'`, set by agent-bridge startSession
  // for the transient boot-check states). Message text is never a signal — a
  // fatal "EACCES … while checking runtime …" would otherwise read as one.
  const isAdmission = (e) => e?.t === 'error' && e.code === 'runtime-check-pending';
  /*
   * BUG-190 round 4: ONE socket, one ordered event stream, and the outcome is
   * decided by ORDER in that stream — never by "no error seen during a sleep".
   * A refused start leaves the socket free (index.ts clears `starting` on the
   * rejection and never binds a session), so a retry is the same `start` sent
   * again on the same socket. Success is the definitive signal — a
   * `session-init` — and only if NO non-admission error precedes it in the
   * stream; a refusal is retried only when it answers the latest send. Rounds
   * 2–3 opened a fresh socket per retry and had to guess, with a settle sleep,
   * whether an error would still land on an earlier one: any finite sleep
   * loses to an error that lands just after it (verifier run 01a0e4e1).
   */
  const c = await openWs(port);
  const tail = () => JSON.stringify(c?.events?.slice(-4) ?? []);
  const fail = (why) => { try { c.ws.close(); } catch { /* closed */ } return new Error(`${why} — last events ${tail()}`); };
  let sent = 0;
  let sentAt = 0;
  const sendStart = () => { c.send(startMsg); sent++; sentAt = Date.now(); };
  sendStart();
  let retryAt = null;
  for (;;) {
    const ev = c.events;
    const initIdx = ev.findIndex((e) => e.t === 'session-init');
    const foreignIdx = ev.findIndex((e) => e.t === 'error' && !isAdmission(e));
    if (foreignIdx >= 0 && (initIdx < 0 || foreignIdx < initIdx)) {
      throw fail(`start failed with a non-admission error (not retried): ${ev[foreignIdx].message ?? JSON.stringify(ev[foreignIdx])}`);
    }
    if (initIdx >= 0) return { c, init: ev[initIdx] };
    const refusals = ev.filter(isAdmission).length;
    if (refusals >= sent) {
      // The latest send was refused by the boot check: resend after retryMs.
      if (sent >= attempts) throw fail(`start still refused by the boot runtime check after ${attempts} attempts`);
      if (retryAt == null) retryAt = Date.now() + retryMs;
      if (Date.now() >= retryAt) { retryAt = null; sendStart(); }
    } else if (Date.now() - sentAt >= initMs) {
      throw fail(`start never initialised within ${initMs} ms`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}
