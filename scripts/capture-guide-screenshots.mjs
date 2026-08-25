#!/usr/bin/env node
/**
 * FEAT-075 Phase 4 — annotated guide screenshots over SYNTHETIC data.
 *
 *   npm run docs:screenshots            # → docs/assets/guide/*.png
 *   GUIDE_SHOTS_OUTDIR=/tmp/x node scripts/capture-guide-screenshots.mjs
 *
 * Boots a SCRATCH server on an OS-assigned free port (never :4317) with a
 * throwaway data dir + Claude store, seeds a SYNTHETIC dataset (the three
 * fictional projects atlas-api / aurora-web / lumen-cli and a generic ticket
 * board — scripts/lib/guide-fixture.mjs, no real names or home paths), drives a
 * headless brave over raw CDP to each UI state the guide references, and for
 * EACH shot injects a DOM overlay (an absolutely-positioned highlight ring +
 * caption computed from the target element's bounding rect) BEFORE capturing.
 *
 * RE-RUNNABLE: the output paths are fixed (guide-fixture SHOTS[].outFile), so
 * re-running refreshes the same PNGs when the UI changes — that is the
 * screenshots' staleness story (docs:fresh covers the prose; this covers the
 * pixels — re-run it when the UI moves).
 *
 * Every widget is lit from the app's OWN render functions (renderTree,
 * applySnapshot, paintCrown, paintModelChip, refreshRail, showTickets) over the
 * injected synthetic state — nothing here re-implements the UI, and nothing
 * captures real project data.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';
import { PROJECTS, SESSIONS, RUNNING, BOARD, SHOTS } from './lib/guide-fixture.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUTDIR = process.env.GUIDE_SHOTS_OUTDIR
  ? path.resolve(process.env.GUIDE_SHOTS_OUTDIR)
  : path.join(ROOT, 'docs', 'assets', 'guide');
const MANIFEST = process.env.GUIDE_SHOTS_MANIFEST
  ? path.resolve(process.env.GUIDE_SHOTS_MANIFEST)
  : path.join(OUTDIR, 'capture-manifest.json');
const BRAVE = process.env.GUIDE_SHOTS_BROWSER ?? 'brave';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-guideshot-data-'));
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-guideshot-store-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-guideshot-brave-'));
// The synthetic project directories the server registers (fictional /tmp paths).
const PROJ_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-guideshot-proj-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

/* --------------------------------------------------------------- raw CDP */
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const c = new Cdp(ws);
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.id && c.waiting.has(m.id)) {
        const { res, rej } = c.waiting.get(m.id);
        c.waiting.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    });
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.waiting.set(id, { res, rej }));
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value;
  }
  async waitFor(label, expr, timeoutMs = 20_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { if (await this.eval(expr)) return true; } catch { /* mid-navigation */ }
      await sleep(120);
    }
    console.log(`      (timed out waiting for ${label} after ${timeoutMs}ms)`);
    return false;
  }
  close() { try { this.ws.close(); } catch { /* already gone */ } }
}

let server = null, browser = null;
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

/* ---------------------------------------- seed the synthetic board on disk */
function seedBoard(projectDir) {
  const bugs = path.join(projectDir, 'docs', 'bugs');
  fs.mkdirSync(bugs, { recursive: true });
  const openRows = BOARD.rows
    .map((r) => `| ${r.id} | ${r.title} | ${r.owner} | ${r.status} | ${r.sev} |`).join('\n');
  const doneRows = BOARD.done.map((d) => `| ${d.id} | ${d.title} | ${d.commit} |`).join('\n');
  fs.writeFileSync(path.join(bugs, 'INDEX.md'),
    `# Board\n\n## Open\n\n` +
    `| ID | Title | Owner | Status | Sev |\n|----|-------|-------|--------|-----|\n${openRows}\n\n` +
    `## Done (committed)\n\n| ID | Title | Commit |\n|----|-------|--------|\n${doneRows}\n`);
  for (const r of BOARD.rows) {
    fs.writeFileSync(path.join(bugs, `${r.id}-${r.id.toLowerCase()}.md`),
      `# ${r.id} — ${r.title}\n\n- **Status:** OPEN\n- **Severity:** ${r.sev}\n\n` +
      `## Activity log (APPEND-ONLY)\n\n### 2026-08-13 — orchestrator\n- filed (synthetic guide fixture).\n`);
  }
  for (const d of BOARD.done) {
    fs.writeFileSync(path.join(bugs, `${d.id}-${d.id.toLowerCase()}.md`),
      `# ${d.id} — ${d.title}\n\n- **Status:** DONE\n`);
  }
}

async function registerProject(base, hostPath, name) {
  const r = await (await fetch(`${base}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath, name }),
  })).json();
  if (!r.project?.id) throw new Error(`could not register ${name}: ${JSON.stringify(r)}`);
  return r.project.id;
}

/* --------- browser-side helpers (injected once after boot) --------------- */
const BROWSER_INIT = `
window.__guide = (() => {
  const S = window.__station;
  const st = S.state;
  const now = Date.now();
  const iso = (ms) => new Date(now - ms).toISOString();

  function inject(F) {
    // Reset transient per-shot state so every shot is independent (no stale
    // live model / pending-new / running-set bleeding in from a prior shot).
    st.live = false;
    st.effective = null;
    st.pendingNew = null;
    st.snap = null;
    st.viewing = 'main';
    st.current = { projectId: null, encodedDir: null, sessionId: null, title: null, os: null };
    const chip = document.querySelector('#modelChip');
    if (chip) delete chip.dataset.flag;
    st.projects = F.projects.map((p) => ({
      id: p.id, name: p.name, hostPath: p.hostPath, isolation: p.isolation,
      lastActivityAt: iso(p.recencyMs),
      settings: {
        model: p.model, effort: null, permissionMode: p.permissionMode,
        instructions: (p.instructions || []).map((tid) => ({ templateId: tid, enabled: true })),
        mounts: p.mounts || [], tools: p.tools || {}, provider: 'anthropic',
        browser: { enabled: false },
      },
    }));
    st.projSort = 'recency';
    S.resortProjects();
    st.showInactive = false;
    return st.projects.map((p) => p.id);
  }

  function select(id, title) {
    st.current = { projectId: id, encodedDir: null, sessionId: null, title: title || null, os: null };
    S.paintCrown();
  }

  // Draw the highlight ring + caption on the target, fixed to the viewport so
  // the screenshot clip (also viewport coords) lines up with no scroll math.
  function annotate(selector, label, opts) {
    opts = opts || {};
    const elt = document.querySelector(selector);
    if (!elt) return { found: false };
    const r = elt.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return { found: false, rect: { w: r.width, h: r.height } };
    const pad = opts.pad == null ? 7 : opts.pad;
    const ring = document.createElement('div');
    ring.className = '__guide_overlay __guide_ring';
    Object.assign(ring.style, {
      position: 'fixed', left: (r.left - pad) + 'px', top: (r.top - pad) + 'px',
      width: (r.width + pad * 2) + 'px', height: (r.height + pad * 2) + 'px',
      border: '2.5px solid #e8663a', borderRadius: '10px',
      boxShadow: '0 0 0 3px rgba(232,102,58,.28), 0 8px 26px rgba(0,0,0,.30)',
      zIndex: 2147483647, pointerEvents: 'none', boxSizing: 'border-box',
    });
    document.body.appendChild(ring);

    const cap = document.createElement('div');
    cap.className = '__guide_overlay __guide_cap';
    cap.textContent = label;
    const below = r.top < 96; // no room above → caption under the target
    Object.assign(cap.style, {
      position: 'fixed', maxWidth: '340px', zIndex: 2147483647, pointerEvents: 'none',
      background: '#e8663a', color: '#fff', font: '600 12.5px/1.35 -apple-system,system-ui,sans-serif',
      padding: '7px 11px', borderRadius: '8px', boxShadow: '0 6px 20px rgba(0,0,0,.32)',
      letterSpacing: '.1px',
    });
    document.body.appendChild(cap);
    const cr = cap.getBoundingClientRect();
    let cx = Math.min(Math.max(8, r.left - pad), window.innerWidth - cr.width - 8);
    let cy = below ? (r.bottom + pad + 10) : (r.top - pad - cr.height - 10);
    cy = Math.min(Math.max(8, cy), window.innerHeight - cr.height - 8);
    cap.style.left = cx + 'px';
    cap.style.top = cy + 'px';

    // The clip region: the target + caption, generously padded, clamped to the
    // viewport so the doc image shows the element in context, not the whole app.
    const clipPad = opts.clipPad == null ? 120 : opts.clipPad;
    const x0 = Math.max(0, Math.min(r.left - pad, cx) - clipPad);
    const y0 = Math.max(0, Math.min(r.top - pad, cy) - clipPad);
    const x1 = Math.min(window.innerWidth, Math.max(r.right + pad, cx + cr.width) + clipPad);
    const y1 = Math.min(window.innerHeight, Math.max(r.bottom + pad, cy + cr.height) + clipPad);
    return { found: true, clip: { x: Math.round(x0), y: Math.round(y0), width: Math.round(x1 - x0), height: Math.round(y1 - y0) } };
  }

  function clearOverlays() {
    for (const e of document.querySelectorAll('.__guide_overlay')) e.remove();
  }

  return { inject, select, annotate, clearOverlays };
})();
`;

/* ---- per-shot setup: light the target widget from the app's own renderers -- */
function setupExpr(name, ids) {
  const auroraId = ids['aurora-web'];
  const atlasId = ids['atlas-api'];
  switch (name) {
    case 'running-strip':
      return `(async () => {
        window.__guide.select(${JSON.stringify(auroraId)}, 'cursor pagination for the activity feed');
        const st = window.__station.state;
        st.viewing = 'main';
        st.current.title = 'cursor pagination for the activity feed';
        window.__station.applySnapshot(${JSON.stringify(RUNNING)}, { trusted: true });
        return true;
      })()`;
    case 'for-you-rail':
      return `(async () => {
        const st = window.__station.state;
        st.current = { projectId: ${JSON.stringify(auroraId)}, encodedDir: null, sessionId: null, title: null, os: null };
        await window.__station.refreshRail(true);
        return true;
      })()`;
    case 'project-sidebar':
      return `(() => {
        const S = window.__station; const st = S.state;
        const now = Date.now();
        const iso = (ms) => new Date(now - ms).toISOString();
        const sess = ${JSON.stringify(SESSIONS['aurora-web'])};
        st.expanded = new Set([${JSON.stringify(auroraId)}]);
        st.current = { projectId: ${JSON.stringify(auroraId)}, encodedDir: null, sessionId: null, title: 'New session', os: 'linux' };
        st.pendingNew = ${JSON.stringify(auroraId)};
        st.sessions = new Map([[${JSON.stringify(auroraId)}, {
          loaded: true, loading: false, error: null, shown: 6, windowed: true,
          encodedDir: 'g-enc-aurora', dirs: [],
          list: sess.map((s) => ({
            sessionId: s.id, encodedDir: 'g-enc-aurora', displayTitle: s.title,
            os: 'linux', lastActivityAt: iso(s.agoMs), pinned: !!s.pinned,
          })),
        }]]);
        S.renderTree();
        return true;
      })()`;
    case 'model-chip':
      return `(() => {
        const S = window.__station; const st = S.state;
        window.__guide.select(${JSON.stringify(auroraId)}, null);
        st.live = true;
        st.effective = { effective: { model: 'claude-sonnet-4-5' }, capabilities: {} };
        S.paintModelChip();
        const chip = document.querySelector('#modelChip');
        if (chip) chip.dataset.flag = 'true'; // the caught-a-silent-fallback state
        return true;
      })()`;
    case 'isolation-chip':
      return `(() => {
        // atlas-api: a container project with permissions skipped — the calm
        // "skips prompts" chip beside the Container isolation chip.
        window.__guide.select(${JSON.stringify(atlasId)}, null);
        return true;
      })()`;
    case 'guide-pill':
      return `(() => {
        window.__guide.select(${JSON.stringify(auroraId)}, null);
        return true;
      })()`;
    case 'board-portal':
      return `(async () => {
        const st = window.__station.state;
        st.current = { projectId: ${JSON.stringify(auroraId)}, encodedDir: null, sessionId: null, title: null, os: null };
        location.hash = '#/tickets/all';
        window.dispatchEvent(new HashChangeEvent('hashchange'));
        return true;
      })()`;
    default:
      return `true`;
  }
}

const shotOpts = {
  'running-strip': { clipPad: 150 },
  'for-you-rail': { clipPad: 90 },
  'project-sidebar': { pad: 5, clipPad: 200 },
  'model-chip': { clipPad: 150 },
  'isolation-chip': { clipPad: 150 },
  'guide-pill': { clipPad: 150 },
  'board-portal': { clipPad: 40 },
};

/** The selector each shot waits for before annotating (defaults to the target). */
const shotWait = {
  'board-portal': '#tvList a.tv-row',
};

async function main() {
  fs.mkdirSync(OUTDIR, { recursive: true });
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;

  // --- seed the synthetic project dirs + aurora's board on disk
  const dirs = {};
  for (const p of PROJECTS) {
    const d = path.join(PROJ_ROOT, p.dir);
    fs.mkdirSync(d, { recursive: true });
    dirs[p.key] = d;
    if (p.hasBoard) seedBoard(d);
  }

  // --- boot the scratch server
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(200); } }
  if (!up) throw new Error('server never became healthy');

  // --- register the three synthetic projects, capture their server ids
  const ids = {};
  for (const p of PROJECTS) ids[p.key] = await registerProject(BASE, dirs[p.key], p.name);

  // the patched fixture the browser injects (real ids + host paths spliced in)
  const patched = {
    projects: PROJECTS.map((p) => ({
      id: ids[p.key], name: p.name, hostPath: dirs[p.key], isolation: p.isolation,
      model: p.model, permissionMode: p.permissionMode, recencyMs: p.recencyMs,
      instructions: p.instructions, mounts: p.mounts, tools: p.tools,
    })),
  };

  // --- launch headless brave, connect CDP
  browser = spawn(BRAVE, [
    '--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', '--force-color-profile=srgb',
    '--window-size=1440,900', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 80 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(200); }
  }
  if (!devPort) throw new Error('browser never wrote DevToolsActivePort');
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  // A crisp, deterministic 1440x900 @2x device.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });

  await cdp.send('Page.navigate', { url: `${BASE}/` });
  const booted = await cdp.waitFor('app booted', 'window.__station !== undefined', 60_000);
  if (!booted) throw new Error('app.js never booted');
  await sleep(800); // let the boot-time background loads settle before we inject
  await cdp.eval(BROWSER_INIT);

  const manifest = [];
  console.log(`\nCapturing ${SHOTS.length} annotated guide screenshots → ${OUTDIR}\n`);
  for (const shot of SHOTS) {
    await cdp.eval(`window.__guide.clearOverlays()`);
    // re-inject the synthetic projects before every shot (idempotent, robust
    // to any background render that touched state between shots)
    await cdp.eval(`window.__guide.inject(${JSON.stringify(patched)})`);
    await cdp.eval(`window.__station.renderTree()`);
    // for non-portal shots make sure the tickets/guide overlays are closed
    if (shot.name !== 'board-portal') {
      await cdp.eval(`(() => { const t = document.querySelector('#ticketsView'); if (t) t.hidden = true; location.hash = ''; })()`);
    }
    await cdp.eval(setupExpr(shot.name, ids));
    const opts = shotOpts[shot.name] ?? {};
    const waitSel = shotWait[shot.name] ?? shot.target;
    await cdp.waitFor(`ready ${waitSel}`,
      `(() => { const e = document.querySelector(${JSON.stringify(waitSel)}); return !!e && e.getBoundingClientRect().width > 0; })()`, 15_000);
    const found = await cdp.eval(`(() => { const e = document.querySelector(${JSON.stringify(shot.target)}); return !!e && e.getBoundingClientRect().width > 0; })()`);
    await sleep(250);
    const ann = await cdp.eval(`window.__guide.annotate(${JSON.stringify(shot.target)}, ${JSON.stringify(shot.label)}, ${JSON.stringify(opts)})`);
    const annOk = !!(ann && ann.found);
    let bytes = 0;
    if (annOk) {
      const clip = { ...ann.clip, scale: 2 };
      const cap = await cdp.send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: false });
      const buf = Buffer.from(cap.data, 'base64');
      fs.writeFileSync(path.join(OUTDIR, shot.outFile), buf);
      bytes = buf.length;
    }
    manifest.push({
      name: shot.name, outFile: shot.outFile, target: shot.target, label: shot.label,
      targetFound: found, annotationInjected: annOk, bytes,
    });
    console.log(`  ${annOk && bytes > 0 ? 'ok  ' : 'MISS'} ${shot.outFile.padEnd(22)} target=${found ? 'found' : 'MISSING'} ${bytes ? `(${(bytes / 1024).toFixed(0)}kB)` : ''}`);
    await cdp.eval(`window.__guide.clearOverlays()`);
  }

  fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
  cdp.close();

  const misses = manifest.filter((m) => !m.annotationInjected || !m.bytes);
  console.log(`\n${manifest.length - misses.length}/${manifest.length} shots captured → ${OUTDIR}`);
  console.log(`manifest → ${MANIFEST}`);
  if (misses.length) { console.log(`  MISSED: ${misses.map((m) => m.name).join(', ')}`); process.exitCode = 1; }
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.stack ?? err.message}`);
  process.exitCode = 1;
}).finally(() => {
  stopByPid(browser);
  stopByPid(server);
  setTimeout(() => {
    for (const d of [DATA, STORE, PROFILE, PROJ_ROOT]) fs.rmSync(d, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  }, 2500);
});
