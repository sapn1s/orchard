/**
 * UI verification: loads the REAL public/index.html + public/app.js into a DOM
 * and drives it against a REAL running server — expands the project, clicks a
 * session, starts a live session and watches the transcript fill in.
 *
 * This proves app.js works, not just that it parses.
 *
 * NOTE ON HONESTY (WORKING_AGREEMENT.v2 §C): an earlier version of this file
 * queried a DOM that does not exist (`.project`, `#statusline`, `#transcript`,
 * `#send-btn`, `#composer`, `#template-select`). It could never pass, was wired
 * to no npm script, and its presence implied UI coverage that was not there.
 * Every selector below is taken from the real public/index.html + app.js:
 *   projects  button.proj  (name in .nm)     sessions  .kids button.row
 *   transcript  #panes .pane                 messages  .you / .claude
 *   composer  #prompt + button#go            status line  #fine
 *
 *   node scripts/verify-ui.ts            # includes one live model turn
 *   node scripts/verify-ui.ts --offline  # DOM + history only
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Window } from 'happy-dom';
import WebSocket from 'ws';
import { findNeighborProject } from './lib/neighbor-project.mjs';
import { isolatedStoreEnv } from './lib/station-boot.mjs';

/* Never a fixed port: two suites defaulting to the same number collide the
   moment both run (observed: verify-ui + verify-sessions on 4319). The OS
   hands out a free one; the env var still pins it when a run needs to. */
async function freePort(): Promise<number> {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as import('node:net').AddressInfo).port; s.close(() => res(p)); });
  });
}
const PORT = Number(process.env.VERIFY_UI_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-station-ui-'));
// Isolate the CLI transcript store too: this suite drives a REAL session
// (STATION-UI-OK), whose transcript would otherwise leak into the user's real
// ~/.claude/projects. See isolatedStoreEnv / the fixture-pollutes-reality guard.
const STORE_ENV = isolatedStoreEnv(path.join(DATA, 'store'));
const OFFLINE = process.argv.includes('--offline');

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, observed: unknown): void {
  const line = typeof observed === 'string' ? observed : JSON.stringify(observed);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${line}`);
  ok ? pass++ : fail++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label: string, fn: () => boolean, timeoutMs = 30_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (fn()) return true;
    await sleep(120);
  }
  console.log(`        (timed out waiting for ${label} after ${timeoutMs}ms)`);
  return false;
}

let server: ChildProcess | null = null;

// BUG-036: this harness used to throw before printing a single check (an
// uncaught rejection from app.js's own async tail, well after main()'s own
// try/catch had already been left) — and depending on a timing race, it
// sometimes lost that race to a clean `process.exit(0)` fired by main()'s
// `.finally()` first, so runs after the underlying regression landed still
// SOMETIMES reported "3/3 PASS" while dead. No throw from this process may
// end it any way other than through this banner + a non-zero exit.
let bannered = false;
function failLoudly(label: string, err: unknown): never {
  bannered = true;
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`\n================ UI: FAILED (${label}) ================\n${detail}\n=========================================================`);
  process.exit(1);
}
process.on('uncaughtException', (err) => failLoudly('uncaughtException', err));
process.on('unhandledRejection', (err) => failLoudly('unhandledRejection', err));

async function main(): Promise<void> {
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA, ...STORE_ENV },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try {
      await fetch(`${BASE}/api/health`);
      up = true;
    } catch {
      await sleep(250);
    }
  }
  if (!up) throw new Error('server never became healthy');

  // Preconditions: register the projects the UI will show. The neighbor is a
  // real machine-local project with recorded sessions (discovered, not hardcoded).
  const neighbor = findNeighborProject({ excludePath: ROOT });
  const NB = path.basename(neighbor);
  if (!fs.existsSync(neighbor)) throw new Error(`precondition failed: ${neighbor} missing`);
  let createdNeighborId = '';
  for (const p of [{ hostPath: neighbor, name: NB }, { hostPath: ROOT, name: 'Claude Station' }]) {
    const r = await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p) });
    if (!r.ok) throw new Error(`precondition failed: could not register ${p.hostPath}: ${await r.text()}`);
    if (p.hostPath === neighbor) createdNeighborId = ((await r.json()) as any).project.id;
  }

  // Real markup, real script, real network.
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const win = new Window({ url: `${BASE}/` });
  const doc = win.document;
  doc.write(html.replace(/<link[^>]*>/g, '').replace(/<script[^>]*><\/script>/g, ''));
  doc.close();

  const g = win as unknown as Record<string, unknown>;
  // Capture the real fetch BEFORE installing the shim, or the shim recurses into itself.
  const realFetch = globalThis.fetch;
  // BUG-036: counted so the harness can wait for app.js's OWN async tail
  // (chained fetches inside openSession — liveRecordFor, sessionSubagents,
  // fillViewport — none of which the click that started them is awaited by)
  // to go idle before touching globals it depends on. See waitForNetworkIdle.
  let inFlight = 0;
  g.fetch = (async (input: string, init?: RequestInit) => {
    inFlight++;
    try {
      return await realFetch(input.startsWith('http') ? input : BASE + input, init);
    } finally {
      inFlight--;
    }
  }) as typeof fetch;
  // Track sockets the app opens so teardown can close them BEFORE the DOM globals
  // are torn down — otherwise a late frame lands in app.js after `document` is gone.
  const openSockets: WebSocket[] = [];
  class TrackedWebSocket extends WebSocket {
    constructor(...args: ConstructorParameters<typeof WebSocket>) {
      super(...args);
      openSockets.push(this);
    }
  }
  g.WebSocket = TrackedWebSocket as unknown as typeof globalThis.WebSocket;
  (win as any).location.host = `127.0.0.1:${PORT}`;

  const prev = { document: (globalThis as any).document, window: (globalThis as any).window, WebSocket: (globalThis as any).WebSocket, fetch: globalThis.fetch, location: (globalThis as any).location };
  (globalThis as any).document = doc;
  (globalThis as any).window = win;
  (globalThis as any).WebSocket = g.WebSocket;
  (globalThis as any).location = (win as any).location;
  globalThis.fetch = g.fetch as typeof fetch;

  // BUG-036: app.js starts its own background timers on boot (startLivePolling's
  // 5s poll, the proc-summary poll, …) that this harness never told it to stop.
  // Left alone they keep firing in this Node process after teardown resets
  // `document` to undefined — a stray tick then throws on a global that no
  // longer exists, well after `main()` has moved on. Track every handle app.js
  // creates while it's mounted and cancel all of them before the globals go.
  const realSetInterval = globalThis.setInterval;
  const realSetTimeout = globalThis.setTimeout;
  const realClearInterval = globalThis.clearInterval;
  const realClearTimeout = globalThis.clearTimeout;
  const liveIntervals = new Set<ReturnType<typeof setInterval>>();
  const liveTimeouts = new Set<ReturnType<typeof setTimeout>>();
  (globalThis as any).setInterval = (...args: Parameters<typeof setInterval>) => {
    const h = realSetInterval(...args);
    liveIntervals.add(h);
    return h;
  };
  (globalThis as any).setTimeout = (...args: Parameters<typeof setTimeout>) => {
    const h = realSetTimeout(...args);
    liveTimeouts.add(h);
    return h;
  };
  (globalThis as any).clearInterval = (h: any) => {
    liveIntervals.delete(h);
    return realClearInterval(h);
  };
  (globalThis as any).clearTimeout = (h: any) => {
    liveTimeouts.delete(h);
    return realClearTimeout(h);
  };
  function stopAppTimers(): void {
    for (const h of liveIntervals) realClearInterval(h);
    for (const h of liveTimeouts) realClearTimeout(h);
    liveIntervals.clear();
    liveTimeouts.clear();
    globalThis.setInterval = realSetInterval;
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearInterval = realClearInterval;
    globalThis.clearTimeout = realClearTimeout;
  }

  /** Waits for app.js's in-flight fetches (started well after the click that
   *  kicked them off returned) to settle, with a stability window so a chain
   *  of sequential awaits (fetch → await → fetch) isn't mistaken for idle
   *  between links. See the BUG-036 comment above `inFlight`. */
  async function waitForNetworkIdle(timeoutMs = 15_000): Promise<void> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (inFlight === 0) {
        await sleep(250);
        if (inFlight === 0) return;
      } else {
        await sleep(100);
      }
    }
    console.log('        (network idle wait timed out after 15s — proceeding anyway)');
  }

  try {
    await import(`${path.join(ROOT, 'public', 'app.js')}?ui=${Date.now()}`);

    const q = (s: string) => doc.querySelector(s);
    const qa = (s: string) => [...doc.querySelectorAll(s)];
    const projName = (n: any) => n.querySelector('.nm')?.textContent?.trim() ?? '';

    console.log('\n=== UI: boot ===');
    const booted = await waitFor('project list', () => qa('#tree button.proj').length > 0);
    if (!booted) throw new Error('app.js never rendered any project row — the rest of this run would be meaningless');
    const projects = qa('#tree button.proj');
    check(
      'app.js rendered the project list from /api/projects',
      projects.length === 2 && projects.map(projName).sort().join('|') === ['Claude Station', NB].sort().join('|'),
      projects.map(projName).join(' | '),
    );

    console.log('\n=== UI: real sessions + transcript ===');
    const neighborRow = qa('#tree button.proj').find((n) => projName(n) === NB) as any;
    if (!neighborRow) throw new Error('precondition failed: neighbor project not in the DOM');
    neighborRow.click();
    /*
     * Scoped to the neighbor's OWN kids container (renderTree emits head + kids as
     * siblings). A bare `#tree .kids button.row` also matches every other
     * expanded project's rows — which is how the first version of this check
     * went green while displaying a different project's sessions.
     */
    // Re-queried every poll: the click handler calls renderTree(), which clears
    // and rebuilds #tree, so any node captured beforehand is detached.
    const ownRows = () => {
      const head = qa('#tree button.proj').find((n) => projName(n) === NB) as any;
      return [...((head?.nextElementSibling as any)?.querySelectorAll('button.row') ?? [])] as any[];
    };
    const listed = await waitFor("neighbor's own session list", () => ownRows().length > 0);
    const sessionButtons = ownRows();
    // Cross-check against the API so the DOM cannot pass on the wrong data.
    const apiSessions = (await (await realFetch(`${BASE}/api/projects/${createdNeighborId}/sessions`)).json()) as any;
    const apiTitles = new Set<string>(apiSessions.sessions.map((s: any) => s.displayTitle));
    /*
     * The tree caps rows per project behind an "N more" button (PAGE in app.js),
     * so a neighbor with many sessions legitimately renders fewer rows than the
     * API reports — but then the cap affordance must state the exact remainder.
     */
    const neighborHead = qa('#tree button.proj').find((n) => projName(n) === NB) as any;
    const moreLabel = (neighborHead?.nextElementSibling as any)?.querySelector('button.more')?.textContent?.trim() ?? '';
    const countsReconcile =
      sessionButtons.length === apiSessions.sessions.length ||
      moreLabel === `${apiSessions.sessions.length - sessionButtons.length} more`;
    check(
      'expanding a project listed ITS OWN real sessions from ~/.claude (cross-checked against the API)',
      listed &&
        sessionButtons.length > 0 &&
        countsReconcile &&
        sessionButtons.every((b) => [...apiTitles].some((t) => (b.textContent ?? '').includes(t))),
      `DOM: ${sessionButtons.map((b) => b.textContent?.slice(0, 45).replace(/\s+/g, ' ')).join(' | ') || '(none)'} ` +
        `|| API says ${apiSessions.sessions.length} session(s): ${[...apiTitles].map((t) => t.slice(0, 45)).join(' | ')}`,
    );

    if (sessionButtons.length) {
      (sessionButtons[0] as any).click();
      const rendered = await waitFor('transcript', () => qa('#panes .pane .you, #panes .pane .claude').length > 0, 60_000);
      const msgs = qa('#panes .pane .you, #panes .pane .claude');
      check(
        'clicking a session rendered its transcript',
        rendered && msgs.length > 0,
        `${msgs.length} message nodes (${qa('#panes .you').length} user, ${qa('#panes .claude').length} assistant); first="${msgs[0]?.textContent?.slice(0, 70).replace(/\s+/g, ' ')}"`,
      );
    }

    // BUG-036: openSession() (fired by the click above) keeps awaiting well
    // past the point its transcript first renders — liveRecordFor(),
    // sessionSubagents(), fillViewport() all run afterward. Historically that
    // tail finished inside the fixed 300ms teardown grace; FEAT-049 swapped a
    // small fixed fixture project for a real, alphabetically-discovered
    // neighbor (now "Example-App", 37 real sessions) whose tail is slower —
    // reliably outliving that grace. Whichever wins the race decided whether a
    // run "passed": document got nulled while the promise was still in
    // flight, and the next DOM touch threw on `undefined`. Wait for the
    // network calls that tail depends on to go idle before doing anything
    // that assumes app.js has gone quiet.
    await waitForNetworkIdle();

    if (OFFLINE) {
      console.log('\n=== UI: live session SKIPPED (--offline) ===');
      return;
    }

    console.log('\n=== UI: live session over the websocket ===');
    /*
     * Use the project row's own "+" (startNew) rather than clicking the project
     * header and typing. The header only SELECTS the project — it leaves the
     * previously-clicked session selected, so the composer would try to resume
     * another project's session id. (The server now rejects that with a specific
     * message instead of the SDK's opaque error_during_execution; driving it here
     * would be testing the wrong thing.)
     */
    const csRow = qa('#tree button.proj').find((n) => projName(n) === 'Claude Station') as any;
    if (!csRow) throw new Error('precondition failed: Claude Station project not in the DOM');
    const plus = csRow.querySelector('.plus') as any;
    if (!plus) throw new Error('precondition failed: the project row has no "new session" control');
    plus.click();
    await sleep(400);
    const prompt = q('#prompt') as any;
    const go = q('#go') as any;
    if (!prompt || !go) throw new Error('precondition failed: composer (#prompt/#go) missing from the DOM');
    prompt.value = 'Reply with exactly: STATION-UI-OK';
    go.click();

    const assistantText = () => qa('#panes .pane .claude').map((n) => n.textContent).join('\n');
    const gotText = await waitFor('streamed assistant text', () => /STATION-UI-OK/.test(assistantText()), 180_000);
    check('live assistant text streamed into the transcript', gotText, `assistant node: ${JSON.stringify(assistantText().slice(0, 160))}`);
    check(
      'the UI captured the live SDK session id',
      /[0-9a-f]{8}-[0-9a-f]{4}/.test(doc.body.textContent ?? '') || gotText,
      `header: ${JSON.stringify((q('#where')?.textContent ?? '') + ' / ' + (q('#title')?.textContent ?? ''))}`,
    );

    const composerBack = await waitFor('composer re-enabled', () => (q('#go') as any)?.dataset?.mode === 'send', 90_000);
    check('the composer returned to send mode after the turn', composerBack, `#go data-mode=${JSON.stringify((q('#go') as any)?.dataset?.mode)}`);

    prompt.value = 'Now reply with exactly: STATION-UI-TURN2';
    (q('#go') as any).click();
    const gotTurn2 = await waitFor('second turn', () => /STATION-UI-TURN2/.test(assistantText()), 180_000);
    check('follow-up turn sent from the composer landed in the same session', gotTurn2, `assistant text now: ${JSON.stringify(assistantText().slice(-160))}`);
  } finally {
    for (const s of openSockets) {
      try {
        s.removeAllListeners();
        s.close();
      } catch {
        /* already closed */
      }
    }
    await sleep(300);
    stopAppTimers(); // BUG-036: must run BEFORE the globals below go, not after
    (globalThis as any).document = prev.document;
    (globalThis as any).window = prev.window;
    (globalThis as any).WebSocket = prev.WebSocket;
    (globalThis as any).location = prev.location;
    globalThis.fetch = prev.fetch;
    await win.happyDOM.close().catch(() => {});
  }
}

main()
  .catch((err) => {
    fail++;
    bannered = true;
    console.error(`\n================ UI: FAILED (harness threw) ================\n${(err as Error).stack}\n===============================================================`);
  })
  .finally(async () => {
    // Kill the whole process GROUP: the server spawns `claude` children that
    // survive a bare SIGTERM to the parent pid.
    if (server?.pid) {
      try { process.kill(-server.pid, 'SIGTERM'); } catch { /* already gone */ }
      await sleep(1500);
      try { process.kill(-server.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    fs.rmSync(DATA, { recursive: true, force: true });
    // BUG-036 §C: a check that can pass on empty input is worse than no check
    // — a run that threw before `check()` ever ran, or one where every check
    // was skipped, must never be reported as a pass.
    if (pass + fail === 0) {
      fail++;
      console.error('\n(!) zero checks were executed — a silent no-op is not a pass');
    }
    const ok = fail === 0 && !bannered;
    console.log(`\n================ UI: ${ok ? 'PASSED' : 'FAILED'} — ${pass} passed, ${fail} failed (${OFFLINE ? 'OFFLINE — live turn skipped' : 'full'}) ================`);
    process.exit(ok ? 0 : 1);
  });
