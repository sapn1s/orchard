/**
 * FEAT-154 round 2 — the SERVER half of cross-row "waiting on you".
 *
 *   node scripts/verify-feat-154-awaiting-field.mjs
 *
 * Proves, end-to-end on an ISOLATED second instance (free port, scratch data +
 * store, fake CLI, killed by pid), that the OWNER of pending questions/permissions
 * — the bridge's own `#approvals` (BUG-166's server side) — PUBLISHES a per-session
 * `awaitingUser` field on `GET /api/sessions`, and that the field tracks the real
 * lifecycle of the request (ARCH-010: one owner, published once, the list reads it):
 *
 *   a. the field is PRESENT and false with no pending request (must-FAIL pre-round-2:
 *      the field did not exist → `undefined`, and a non-open row could never show amber);
 *   b. it flips to TRUE while a real `can_use_tool` request is outstanding;
 *   c. it CLEARS to false the moment the request is answered.
 *
 * The pending request is REAL: a fake CLI emits an actual control-protocol
 * `can_use_tool`, the bridge stores it in `#approvals` and announces the card to
 * the attached client, exactly as a live session would. Nothing here fabricates
 * the field's value — it is read straight off the running server.
 *
 * Never touches :4317 / the live service / foreign scopes (bug-187-harness).
 */
import {
  sleep, makeChecker, makeWorld, bootServer, stopServer, registerProject,
  startFakeSession, fakeCmd, waitEv, waitFor, cleanupWorld,
} from './lib/bug-187-harness.mjs';

const chk = makeChecker('FEAT-154 awaiting-field');
const w = makeWorld('feat-154-await');
let srv = null;

try {
  srv = await bootServer(w);
  const pid = await registerProject(srv, w);
  const { c, station, cli } = await startFakeSession(srv, w, pid, 'hello');

  const sessions = async () =>
    (await (await fetch(`http://127.0.0.1:${srv.port}/api/sessions`)).json()).sessions ?? [];
  const rowOf = async () => (await sessions()).find((s) => s.stationSessionId === station) ?? null;

  // Wait for the bridge row to exist on the list at all.
  const r0 = await waitFor(async () => await rowOf(), 15_000);
  chk.check('(a) the /api/sessions row carries an `awaitingUser` field (must-FAIL pre-round-2: undefined)',
    !!r0 && Object.prototype.hasOwnProperty.call(r0, 'awaitingUser'),
    JSON.stringify({ present: !!r0 && 'awaitingUser' in (r0 ?? {}), value: r0?.awaitingUser }));
  chk.check('(a) baseline: awaitingUser is FALSE before any pending request',
    r0?.awaitingUser === false, r0?.awaitingUser);

  // Trigger a REAL pending approval: the fake CLI emits a can_use_tool request.
  fakeCmd(w, cli, { op: 'perm', tool: 'Write', toolInput: { file_path: '/tmp/f154-await.txt', content: 'x' } });
  const req = await waitEv(c, (e) => e.t === 'approval-request', 20_000);
  chk.check('the bridge announced a real pending approval-request to the attached client',
    !!req && !!req.requestId, req ? { t: req.t, requestId: req.requestId } : null);

  const becameTrue = await waitFor(async () => (await rowOf())?.awaitingUser === true, 15_000);
  chk.check('(b) the OWNER published awaitingUser=TRUE while the request is outstanding',
    becameTrue === true, { awaitingUser: (await rowOf())?.awaitingUser });

  // Answer it over the same socket (allow) — the pending resolves and is deleted.
  c.send({ type: 'approval-response', requestId: req.requestId, allow: true });
  const becameFalse = await waitFor(async () => (await rowOf())?.awaitingUser === false, 15_000);
  chk.check('(c) awaitingUser CLEARS to false the moment the request is answered',
    becameFalse === true, { awaitingUser: (await rowOf())?.awaitingUser });

  try { c.close(); } catch { /* ignore */ }
} catch (err) {
  chk.check('no fatal error', false, String(err?.stack ?? err));
} finally {
  if (srv) await stopServer(srv);
  await cleanupWorld(w);
}

const failed = chk.results.filter((r) => !r.ok);
console.log(`\n${chk.results.length - failed.length}/${chk.results.length} checks passed`);
if (failed.length) console.log(`failed: ${failed.map((r) => r.name).join(' | ')}`);
process.exit(failed.length ? 1 : 0);
