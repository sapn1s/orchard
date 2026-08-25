#!/usr/bin/env node
/**
 * FEAT-040 — `station doctor`: prints GROUND TRUTH for every live session,
 * read straight off `GET /api/health` (src/server/index.ts). This exists so
 * "is this session protected against a restart / what state is it in" is
 * answered by one reliable tool instead of a hand-rolled `ps`/`grep` that can
 * quietly ask the wrong question (a PPID check once falsely declared FEAT-015
 * broken — see docs/bugs/FEAT-040-session-state-legibility.md). The server
 * itself does the actual verification (cgroup-membership, not PPID); this
 * script only reads and renders it.
 *
 * Usage:
 *   npm run doctor
 *   node scripts/station-doctor.mjs [--port 4317] [--host 127.0.0.1] [--json]
 *
 * Defaults to the real running station (127.0.0.1:4317) — this is a READ-ONLY
 * GET, so it is safe to point at the live service; it never binds, restarts,
 * or otherwise touches the server. A scratch server on another port works the
 * same way via --port.
 */
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    port: { type: 'string', default: process.env.PORT ?? '4317' },
    host: { type: 'string', default: '127.0.0.1' },
    json: { type: 'boolean', default: false },
  },
});

const base = `http://${args.host}:${args.port}`;

function fmtBool(v) {
  if (v === true) return 'yes';
  if (v === false) return 'no';
  return '—'; // null/undefined — unknown, never guessed
}

function stateLabel(s) {
  switch (s.state) {
    case 'detached-running': return 'DETACHED (running headless)';
    case 'busy': return 'busy';
    case 'idle': return 'idle';
    // BUG-027: a FEAT-015 broker + CLI alive in their own scope with NO live
    // bridge in the current server — the exact post-restart state that used to
    // be reported as "no sessions" while the work was alive.
    case 'surviving-unadopted': return 'SURVIVED a restart (broker + CLI alive, NOT adopted by this server — turn draining; the thread continues via resume)';
    // ARCH-001: the bridge still holds a `busy` flag but the authority no
    // longer vouches for it (its process is gone, or it has been silent past
    // the backstop with nothing to check). It is about to be reaped; saying
    // "busy" here is the exact dishonesty BUG-033 was about.
    case 'not-running': return 'NOT running (the bridge still claims a turn, but nothing is behind it — being reaped)';
    default: return s.state;
  }
}

function printSession(s) {
  const lines = [];
  const head = s.adopted === false ? 'survivor' : 'session';
  lines.push(`${head} ${s.stationSessionId ?? '(unknown station id)'}${s.sdkSessionId ? ` (sdk ${s.sdkSessionId.slice(0, 8)})` : ''}`);
  lines.push(`  project        ${s.projectId ?? '—'}`);
  lines.push(`  isolation      ${s.isolation}`);
  lines.push(`  state          ${stateLabel(s)}`);
  lines.push(`  adopted        ${fmtBool(s.adopted)}  (is this a live in-memory session of the current server?)`);
  lines.push(`  busy           ${fmtBool(s.busy)}${s.busyClaimed !== undefined && s.busyClaimed !== s.busy ? `  (the bridge CLAIMS ${fmtBool(s.busyClaimed)} — the verdict above overrides it)` : ''}`);
  if (s.liveness) lines.push(`  liveness       ${s.liveness.state} · ${s.liveness.kind} — ${s.liveness.reason}`);
  lines.push(`  detached       ${fmtBool(s.detached)}`);
  lines.push(`  survival:`);
  lines.push(`    configured   ${fmtBool(s.survivalConfigured)}  (attempted at spawn time — a CLAIM)`);
  lines.push(`    scoped       ${fmtBool(s.survivalScoped)}  (GROUND TRUTH — verified by cgroup membership just now)`);
  if (s.survivalConfigured && s.survivalScoped === false) {
    lines.push(`    ⚠ configured but NOT scoped — this session is NOT actually protected against a restart right now`);
  }
  if (s.broker) {
    lines.push(`  broker:`);
    lines.push(`    hostPid      ${s.broker.hostPid}`);
    lines.push(`    claudePid    ${s.broker.claudePid ?? '—'}`);
    lines.push(`    state        ${s.broker.state}`);
    lines.push(`    sock         ${s.broker.sock}`);
  } else {
    lines.push(`  broker         none`);
  }
  return lines.join('\n');
}

async function main() {
  let res;
  try {
    res = await fetch(`${base}/api/health`);
  } catch (err) {
    console.error(`station doctor: could not reach ${base} — is the server running? (${err.message})`);
    process.exitCode = 1;
    return;
  }
  if (!res.ok) {
    console.error(`station doctor: ${base}/api/health answered HTTP ${res.status}`);
    process.exitCode = 1;
    return;
  }
  const health = await res.json();

  if (args.json) {
    console.log(JSON.stringify(health, null, 2));
    return;
  }

  console.log(`station doctor — ${base}`);
  console.log(`  pid            ${health.pid}`);
  console.log(`  dataDir        ${health.dataDir}`);
  console.log(`  liveBridges    ${health.liveBridges}`);
  console.log('');

  const sessions = Array.isArray(health.sessions) ? health.sessions : [];
  if (!sessions.length) {
    // BUG-027: this line is only honest now that /api/health also surfaces
    // un-adopted survivors — an alive-but-unattached broker lands in
    // sessions[] (adopted:false) instead of vanishing into this message.
    console.log('No live sessions and no surviving session hosts right now.');
    return;
  }
  for (const s of sessions) {
    console.log(printSession(s));
    console.log('');
  }
  const unadopted = sessions.filter((s) => s.adopted === false);
  if (unadopted.length) {
    console.log(`⚠ ${unadopted.length} surviving session host(s) from a prior server run are alive but NOT adopted — their in-flight turn is draining to completion; resume the session to continue the thread.`);
  }
}

await main();
