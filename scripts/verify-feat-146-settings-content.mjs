/**
 * FEAT-146 (phase 2a) — LIVE PROOF that the settings pane FILTERS by category.
 *
 *   node scripts/verify-feat-146-settings-content.mjs
 *
 * Phase 1 shipped the rail with a deliberate seam: the rail SELECTED, but every
 * project category still rendered the whole of `settingsView()`. Phase 2a closes
 * it — each of the 11 categories builds only the cards it owns. The failure mode
 * a re-home like this actually has is SILENT LOSS: a control that quietly stops
 * being built by anybody. So the assertion that matters here is COMPLETENESS,
 * and it is two-directional:
 *
 *   1. every control in the pre-redesign inventory is still rendered by exactly
 *      one category, is reachable, and still writes the same key;
 *   2. no category renders another category's cards.
 *
 * The pre-redesign inventory is pinned to commit dc1f4ea (the last commit before
 * this redesign started) rather than to HEAD, so it cannot become the fixed
 * state the moment the fix is committed.
 *
 * Also proved here: the new project-scope Claude-account control (writes
 * `settings.claudeAccount`; locked with its reason on screen under the session
 * lens on a container project, and writing nothing there), the rail dots against
 * their real conditions in both directions, the anchors phase 2 re-homed, and
 * both themes at 940/800/500 with zero console errors.
 *
 * ROUND 5 (2026-09-19) adds the thing the clean-room verifier could NOT rule
 * out: completeness had only ever been measured on ONE project shape (non-git,
 * snapshot-less, container-or-direct, two accounts, no live session), so a
 * control that renders only in some other shape could have been dropped with
 * nothing to notice. Section 8 grades NINE shapes — a real git repository with
 * a remote and an upstream, a repo with no remote, no repo at all, the sandbox
 * isolation tier, a container with and without mounts and services, snapshots
 * present, both snapshot FAILURE channels, and a machine with only the default
 * Claude account — each as a complete two-directional statement: every probe is
 * either assigned a category or must be absent from all eleven. Section 9 does
 * the same for a live session under both lens positions, and section 10 covers
 * the rail's scroll-aware edge fades.
 *
 * Non-vacuity: the completeness sweep is re-run against a SYNTHESIZED pre-fix
 * variant of drawer.js — one card dropped from one category's builder, served
 * over CDP Fetch interception — and must go red. Anchored to a constructed
 * broken variant, never to a moving revision.
 *
 * Harness: the real server + brave --headless=new over raw CDP — the SAME shape
 * phase 1 used (scripts/verify-feat-146-settings-shell.mjs), deliberately not a
 * second harness. Ports are OS-assigned. Every process is one this script
 * spawned and is stopped by PID. No product code is modified on disk.
 *
 * Leak hygiene: every path used here is created by this script under the system
 * temp dir; no home path, no username and no real project path is written to
 * disk or printed. Confirm with `node scripts/leak-gate.mjs --summary`.
 */
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
const BRAVE = process.env.VERIFY_BROWSER ?? 'brave';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

/* ─────────────────────────── the pinned inventory ───────────────────────────
 * Every `.f` flag string `public/lib/drawer.js` could render at commit dc1f4ea
 * — i.e. BEFORE this redesign — extracted from that revision and pinned here so
 * the baseline cannot move. A flag string is the key the row writes, printed on
 * screen next to it, which is why it doubles as the "still writes the same key"
 * assertion: the row is found by its flag, so a row that silently changed key
 * would not be found at all.
 */
const FLAG_INVENTORY = {
  '--model': 'model',
  '--effort': 'model',
  '--max-budget-usd': 'model',
  '--permission-mode': 'permissions',
  '--allowed-tools': 'permissions',
  '--disallowed-tools': 'permissions',
  '--settings › browser.enabled': 'permissions',
  '--settings › tools.serena': 'permissions',
  '--settings › tools.playwright · UI testing': 'permissions',
  '--settings › tools.openaiDispatch': 'permissions',
  '--settings › responseDigest.enabled': 'instructions',
  '--settings › container.image': 'isolation',
  '--settings › container.memoryMb': 'isolation',
  '--settings › snapshots.enabled': 'snapshots',
  '--settings › snapshots.keep': 'snapshots',
  '--settings › snapshots.exclude': 'snapshots',
};

/**
 * The controls that carry no flag string, identified by what they ARE. Each
 * entry: [label, category, selector-inside-the-pane, the key it writes].
 * `where` is evaluated against the visible view host.
 */
const CONTROL_INVENTORY = [
  ['provider segmented control', 'model', '[data-focus="provider"] .prov-seg button[data-prov="openai"]', 'settings.provider'],
  ['machine-wide model default link', 'model', '[data-focus="projectModel"] .addrow', 'navigation → defaults'],
  ['project Claude-account picker (NEW)', 'model', '#pAccountSel', 'settings.claudeAccount'],
  ['isolation segmented control', 'isolation', '[data-focus="iso"] .seg button', 'isolation'],
  ['mounts list + add', 'isolation', '[data-focus="mounts"] .addrow', 'settings.mounts'],
  ['docker-socket switch', 'isolation', '[data-focus="mounts"] .sw[data-risk]', 'settings.container.dockerSocket'],
  ['services list + add', 'isolation', '[data-focus="services"]', 'settings.services'],
  ['instruction-stack editor door', 'instructions', '[data-focus="instructions"] .addrow', 'settings.instructions'],
  ['response-digest guidance field', 'instructions', '.guidance-in', 'settings.responseDigest.guidance'],
  ['working directory + repoint', 'workspace', '.proj-dir-box .dir-change', 'project.hostPath'],
  ['git group', 'workspace', '[data-focus="git"]', 'git actions'],
  ['processes group', 'workspace', '[data-focus="processes"]', 'process stop'],
  ['methodology wiring panel', 'advanced', '[data-focus="wiring"]', 'wiring apply'],
  ['agent memories', 'advanced', '[data-focus="memories"]', 'memory read/delete'],
  ['take a snapshot', 'snapshots', '[data-focus="snapshots"] .addrow', 'snapshot create'],
  ['appearance theme control', 'appearance', '[data-focus="appearance"] .seg button', 'theme'],
  ['global default model picker', 'defaults', '#gModelSel', 'global.model'],
  ['global custom model id field', 'defaults', '#gModelCustomInput', 'global.model'],
  ['global default effort picker', 'defaults', '#gEffortSel', 'global.effort'],
  ['new-project seeds (isolation/dispatch/MCP)', 'defaults', '[data-focus="newProjectDefaults"] + .gseg, [data-focus="newProjectDefaults"] .gseg', 'global.isolation/serena/…'],
  ['projects that override the model', 'defaults', '[data-focus="modelOverrides"]', 'read-only report'],
  ['default Claude account picker', 'accounts', '#gAccountSel', 'global.claudeAccount'],
  ['accounts list + add account', 'accounts', '#gAcctAdd', 'account create/delete'],
  ['template library rows', 'templates', '.lrow', 'template open/edit'],
];

/* Category → a selector that is TRUE only when that category's own content is on
 * screen. Used in both directions: present in its own category, absent in the
 * other ten. */
const CATEGORY_MARKER = {
  model: '[data-focus="projectModel"]',
  permissions: '[data-focus="permissionMode"]',
  instructions: '[data-focus="instructions"]',
  isolation: '[data-focus="iso"]',
  snapshots: '[data-focus="snapshotsGroup"]',
  workspace: '[data-focus="processes"]',
  advanced: '[data-focus="wiring"]',
  accounts: '[data-focus="globalAccount"]',
  appearance: '[data-focus="appearance"]',
  defaults: '[data-focus="newProjectDefaults"]',
  templates: '[data-grp="working-agreement"], .lrow, [data-focus="globalTemplates"]',
};

/* The anchors phase 2 MOVED or re-homed. Phase 1's suite drives all 20 keys on
 * both projects and stays green; these are the ones this phase changed, so they
 * are re-measured here (resolve + scroll + flash) rather than taken on trust. */
const MOVED_ANCHORS = {
  model: 'model', caps: 'permissions', instr: 'instructions', isoSection: 'isolation',
  provider: 'model', snapshotsGroup: 'snapshots', globalTemplates: 'templates',
  projectAccount: 'model',
};

const RAIL_IDS = ['model', 'permissions', 'instructions', 'isolation', 'snapshots', 'workspace',
  'advanced', 'accounts', 'appearance', 'defaults', 'templates'];

/* ══════════════ FEAT-146 round 5 — SHAPE completeness (section 9) ══════════
 *
 * The clean-room verifier's largest could-not-test, verbatim in substance:
 * "control-completeness on a git-REPOSITORY project shape and a
 * snapshots-present shape — every fixture (the authors' and the verifier's)
 * uses non-git, snapshot-less scratch dirs … so a control dropped only in
 * those shapes could not be ruled out."
 *
 * The inventory above is real but SHAPE-BLIND: it was measured on one project
 * shape (container / direct, non-git, snapshot-less, no live session, two
 * accounts), so roughly a third of what `drawer.js` can build was never on
 * screen while it ran. Four of the eleven categories change their whole
 * contents with the shape of the project: Workspace (repo / no repo / remote /
 * upstream), Snapshots (none / present / failed), Isolation (container /
 * sandbox / direct, mounts and services present or empty) and Model & spend
 * (one account or several).
 *
 * So each SHAPE below is a full two-directional statement about what that shape
 * makes reachable: every probe is either assigned a category (present there, in
 * EXACTLY one category, nowhere else) or implicitly forbidden (absent from all
 * eleven). "Implicitly" is deliberate — a shape may not stay silent about a
 * control, which is what let the shape-gated ones go unmeasured in the first
 * place.
 */

/**
 * One probe = one thing a user can see or press. `sel` is matched inside the
 * visible view host; `re` (when present) must match the node's trimmed text, so
 * a probe identifies the CONTROL and not merely a container that still exists.
 */
const SHAPE_PROBES = [
  /* Git — the whole card is shape-gated and nothing above measured any of it. */
  { id: 'git.status', what: 'the git status line (branch · dirty · tracking)', sel: '[data-focus="git"] .mono-line' },
  { id: 'git.workbench', what: '"Open Git workbench"', sel: '[data-focus="git"] button.mini', re: '^Open Git workbench$' },
  { id: 'git.review', what: '"Review and stage N changed files"', sel: '[data-focus="git"] button.mini', re: '^Review and stage \\d+ changed files?$' },
  { id: 'git.push', what: '"Push…"', sel: '[data-focus="git"] button.mini', re: '^Push…$' },
  { id: 'git.pull', what: '"Pull (ff-only)"', sel: '[data-focus="git"] button.mini', re: '^Pull \\(ff-only\\)$' },
  { id: 'git.create', what: '"Create GitHub repo…"', sel: '[data-focus="git"] button.mini', re: '^Create GitHub repo…$' },
  { id: 'git.init', what: '"git init"', sel: '[data-focus="git"] button.mini', re: '^git init$' },
  { id: 'git.refresh', what: 'the status re-read button', sel: '[data-focus="git"] button.mini', re: '^Refresh$' },
  { id: 'git.terminal', what: 'the kitty terminal link', sel: '[data-focus="git"] button.mini', re: 'terminal \\(kitty\\)' },
  { id: 'git.notrepo', what: '"Not a git repository" note', sel: '[data-focus="git"] .grp-note', re: 'Not a git repository' },
  /* Snapshots — the list, the two failure channels, the empty state. */
  { id: 'snap.row', what: 'a restorable snapshot row', sel: '.snap:not(.failed)' },
  { id: 'snap.restore', what: 'the per-snapshot Restore button', sel: '.snap .acts button', re: '^Restore$' },
  { id: 'snap.delete', what: 'the per-snapshot delete ×', sel: '.snap .acts button.x' },
  { id: 'snap.take', what: '"+ Take one now"', sel: '.addrow', re: 'Take one now' },
  { id: 'snap.empty', what: 'the "No snapshots yet" empty state', sel: '.grp-note', re: 'No snapshots yet' },
  { id: 'snap.failedRow', what: 'a failed-snapshot row', sel: '.snap.failed' },
  { id: 'snap.failNote', what: 'failureNote() — "The last snapshot failed."', sel: '.risk .set-why b', re: 'snapshots? failed' },
  { id: 'snap.liveFail', what: 'liveFailureNote() — "This session has no restore point."', sel: '.risk .set-why b', re: 'This session has no restore point' },
  /* Isolation — the third tier, and the container-only cards in both states. */
  { id: 'iso.sandboxOn', what: 'the Sandbox tier selected', sel: '[data-focus="iso"] .seg button[aria-pressed="true"]', re: '^Sandbox$' },
  { id: 'iso.containerOn', what: 'the Container tier selected', sel: '[data-focus="iso"] .seg button[aria-pressed="true"]', re: '^Container$' },
  { id: 'iso.directOn', what: 'the Direct tier selected', sel: '[data-focus="iso"] .seg button[aria-pressed="true"]', re: '^Direct$' },
  { id: 'iso.confined', what: 'the sandbox safety note ("confined to the project directory")', sel: '[data-focus="iso"] .grp-note', re: 'confined to the project directory' },
  { id: 'iso.unheld', what: 'the direct-mode note ("nothing held back")', sel: '[data-focus="iso"] .grp-note', re: 'nothing held back' },
  { id: 'iso.access', what: 'the Access card', sel: '[data-focus="mounts"]' },
  { id: 'iso.mountRow', what: 'a mount row', sel: '[data-focus="mounts"] .mrow .dst' },
  { id: 'iso.addMount', what: '"+ Add mount"', sel: '.addrow', re: 'Add mount' },
  { id: 'iso.socket', what: 'the docker-socket switch', sel: '[data-focus="mounts"] .sw[data-risk]' },
  { id: 'svc.card', what: 'the Services card', sel: '[data-focus="services"]' },
  { id: 'svc.row', what: 'a service row', sel: '[data-focus="services"] .mrow .dst' },
  { id: 'svc.empty', what: 'the "No service sidecars" empty state', sel: '[data-focus="services"] .grp-note', re: 'No service sidecars' },
  { id: 'svc.add', what: '"+ Add service"', sel: '.addrow', re: 'Add service' },
  /* Accounts — the one-account shape is a DIFFERENT control from the picker. */
  { id: 'acct.projectSel', what: 'the project-scope account picker', sel: '#pAccountSel' },
  { id: 'acct.onlyRow', what: 'the read-only account row (one account only)', sel: '[data-focus="projectAccount"] .set .f', re: 'claudeAccount' },
  { id: 'acct.onlyDoor', what: '"Accounts on this machine ›"', sel: '.addrow', re: 'Accounts on this machine' },
  { id: 'acct.globalSel', what: 'the machine default account picker', sel: '#gAccountSel' },
  { id: 'acct.globalOnly', what: 'the machine "only the default account" note', sel: '[data-focus="globalAccount"] .grp-note', re: 'Only the default account' },
  { id: 'acct.add', what: '"+ Add account"', sel: '#gAcctAdd' },
];

/* Flags every shape must render, and the ones that are legitimately gated. A
 * shape declares which gated groups it turns on; everything else must be
 * present everywhere, on every shape. */
const CONTAINER_FLAGS = ['--settings › container.image', '--settings › container.memoryMb'];
const SNAPON_FLAGS = ['--settings › snapshots.keep', '--settings › snapshots.exclude'];
const ALWAYS_FLAGS = Object.keys(FLAG_INVENTORY)
  .filter((f) => !CONTAINER_FLAGS.includes(f) && !SNAPON_FLAGS.includes(f));

/* ── infra (same shape as phase 1) ── */
const procs = [];
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}
async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); this.handlers = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const c = new Cdp(ws);
    ws.on('message', (dd) => {
      const m = JSON.parse(dd.toString());
      if (m.id && c.waiting.has(m.id)) {
        const { res, rej } = c.waiting.get(m.id);
        c.waiting.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else if (m.method) {
        for (const h of c.handlers.get(m.method) ?? []) h(m.params);
      }
    });
    return c;
  }
  on(method, fn) { if (!this.handlers.has(method)) this.handlers.set(method, []); this.handlers.get(method).push(fn); }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.waiting.set(id, { res, rej })); }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value;
  }
  async waitFor(label, expr, timeoutMs = 30000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) { try { if (await this.eval(expr)) return true; } catch { /* mid-nav */ } await sleep(120); }
    console.log(`        (timed out waiting for ${label})`);
    return false;
  }
  async theme(tone) { await this.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: tone }] }); }
  async viewport(width, height) { await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

let cdp = null, browser = null, server = null;
const shots = [];
let consoleErrors = [];

async function shot(name, minKb = 6) {
  const file = path.join(ROOT, name);
  await cdp.shot(file);
  const kb = fs.statSync(file).size / 1024;
  check(`capture ${name} (non-blank, > ${minKb}KB)`, kb > minKb, `${kb.toFixed(1)} KB`);
  shots.push(file);
  return file;
}

/**
 * Walk all 11 categories and report, for each, the flag strings and the control
 * selectors it renders. One pass, so the two directions below are read off the
 * SAME observation rather than two separate visits that could disagree.
 */
const SWEEP = `(async () => {
  const D = window.__station.drawer;
  const CONTROLS = ${JSON.stringify(CONTROL_INVENTORY.map(([label, catg, sel]) => ({ label, catg, sel })))};
  const MARKERS = ${JSON.stringify(CATEGORY_MARKER)};
  const out = {};
  for (const id of ${JSON.stringify(RAIL_IDS)}) {
    D.close(); D.close();
    await D.open('settings');
    document.querySelector('.srail-item[data-cat="' + id + '"]').click();
    // Let the async reads (git, processes, wiring, globals, accounts, snapshots)
    // land: a card that arrives late is still a card this category renders.
    await new Promise((r) => setTimeout(r, 1200));
    const host = document.querySelector('#dBody .view.on');
    out[id] = {
      flags: [...host.querySelectorAll('.f')].map((n) => n.textContent),
      controls: CONTROLS.filter((c) => !!host.querySelector(c.sel)).map((c) => c.label),
      markers: Object.entries(MARKERS).filter(([, sel]) => !!host.querySelector(sel)).map(([k]) => k),
      cards: host.querySelectorAll('.grp').length,
    };
  }
  D.close(); D.close();
  return out;
})()`;

/**
 * The same walk as SWEEP, but reporting the shape probes instead of the
 * inventory — and under a named lens, because half the shape-gated controls
 * (the project-only notes, the locked pickers) only exist under one of them.
 */
const SHAPE_SWEEP = (scope) => `(async () => {
  const D = window.__station.drawer;
  const PROBES = ${JSON.stringify(SHAPE_PROBES.map(({ id, sel, re }) => ({ id, sel, re: re ?? null })))};
  const out = {};
  for (const id of ${JSON.stringify(RAIL_IDS)}) {
    D.close(); D.close();
    await D.open('settings', { scope: ${JSON.stringify(scope)} });
    document.querySelector('.srail-item[data-cat="' + id + '"]').click();
    await new Promise((r) => setTimeout(r, 1300));
    const host = document.querySelector('#dBody .view.on');
    const hit = [];
    for (const pr of PROBES) {
      let ns = [...host.querySelectorAll(pr.sel)];
      if (pr.re) { const rx = new RegExp(pr.re); ns = ns.filter((n) => rx.test((n.textContent || '').trim())); }
      if (ns.length) hit.push(pr.id);
    }
    out[id] = { hit, flags: [...host.querySelectorAll('.f')].map((n) => n.textContent) };
  }
  D.close(); D.close();
  return out;
})()`;

/**
 * Grade one shape. `expect` is the COMPLETE statement of what this shape makes
 * reachable — every probe not named in it must be absent from all 11
 * categories. Returns the failures as prose that NAMES the rows, so a dropped
 * group reports what vanished rather than a bare count.
 */
function gradeShape(sweep, { expect, gated = [] }) {
  const homes = new Map();      // probe id -> [categories]
  const flagsSeen = new Set();
  for (const [catg, r] of Object.entries(sweep)) {
    for (const id of r.hit) homes.set(id, [...(homes.get(id) ?? []), catg]);
    for (const f of r.flags) flagsSeen.add(f);
  }
  const label = (id) => `${id} (${SHAPE_PROBES.find((p) => p.id === id)?.what ?? '?'})`;
  const missing = [];
  const misplaced = [];
  const duplicated = [];
  for (const [id, catg] of Object.entries(expect)) {
    const h = homes.get(id) ?? [];
    if (!h.length) missing.push(label(id));
    else if (!h.includes(catg)) misplaced.push(`${label(id)}: expected ${catg}, found ${h.join('+')}`);
    else if (h.length > 1) duplicated.push(`${label(id)} → ${h.join('+')}`);
  }
  const unexpected = [...homes.keys()].filter((id) => !(id in expect)).map((id) => `${label(id)} → ${homes.get(id).join('+')}`);
  const wantFlags = [...ALWAYS_FLAGS, ...gated];
  const flagMissing = wantFlags.filter((f) => !flagsSeen.has(f));
  const flagExtra = [...CONTAINER_FLAGS, ...SNAPON_FLAGS].filter((f) => !gated.includes(f) && flagsSeen.has(f));
  return { missing, misplaced, duplicated, unexpected, flagMissing, flagExtra, homes };
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feat146b-verify-'));
  const DATA = path.join(tmp, 'data');
  const CFG = path.join(tmp, 'cfg');
  const STORE = path.join(CFG, 'projects');
  const DIRECT = path.join(tmp, 'p-direct');
  const CONTAINER = path.join(tmp, 'p-container');
  const GONE = path.join(tmp, 'p-gone');
  const BIN = path.join(tmp, 'bin');
  /* Round 5 — the project SHAPES no fixture used to build (section 9). */
  const GIT_UP = path.join(tmp, 'p-git-tracking');   // repo + origin + upstream + dirty
  const GIT_NR = path.join(tmp, 'p-git-local');      // repo, clean, no remote
  const SANDBOX = path.join(tmp, 'p-sandbox');       // the third isolation tier
  const CBARE = path.join(tmp, 'p-container-bare');  // container, no mounts, no services
  const SNAPP = path.join(tmp, 'p-snaps');           // snapshots really present
  for (const dd of [DATA, CFG, STORE, DIRECT, CONTAINER, GONE, BIN, GIT_UP, GIT_NR, SANDBOX, CBARE, SNAPP]) {
    fs.mkdirSync(dd, { recursive: true });
  }

  /* ── the git fixtures ──────────────────────────────────────────────────────
   * Built with real git so the card reads a real `git status`, and confined to
   * this script's own scratch dir — no repository outside `tmp` is touched and
   * no network is reachable (the "remote" is an example.invalid URL, and the
   * upstream ref is set with update-ref rather than by pushing anywhere).
   * The identity is obviously synthetic per docs/CONVENTIONS.md, and the
   * global/system config is detached so the user's identity cannot leak in.
   * A prior lane's `git init` was refused by an agent git-write guard; if that
   * happens here the PRECONDITION below FAILS LOUDLY with the refusal quoted,
   * rather than the git shapes quietly not being tested. */
  const GIT_ENV = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'verify', GIT_AUTHOR_EMAIL: 'verify@example.invalid',
    GIT_COMMITTER_NAME: 'verify', GIT_COMMITTER_EMAIL: 'verify@example.invalid',
  };
  const g = (cwd, args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  let gitFixtureError = null;
  try {
    for (const repo of [GIT_UP, GIT_NR]) {
      g(repo, ['init', '-q', '-b', 'main', '.']);
      fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
      g(repo, ['add', '-A']);
      g(repo, ['commit', '-q', '-m', 'fixture commit']);
    }
    // A remote with an upstream, without a push: the status line's `tracks …`
    // branch and the Pull button both hang off @{upstream}, nothing else.
    g(GIT_UP, ['remote', 'add', 'origin', 'https://example.invalid/verify/fixture.git']);
    g(GIT_UP, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    g(GIT_UP, ['config', 'branch.main.remote', 'origin']);
    g(GIT_UP, ['config', 'branch.main.merge', 'refs/heads/main']);
    fs.writeFileSync(path.join(GIT_UP, 'README.md'), '# fixture\nchanged\n');
  } catch (err) {
    gitFixtureError = `${err.message} :: ${String(err.stderr ?? '')}`.slice(0, 300);
  }
  check('PRECONDITION: the two git fixture repos were built (a refusal here is an agent git-write guard, not a product defect — it is reported, never skipped)',
    gitFixtureError === null, gitFixtureError ?? `${GIT_UP.split('/').pop()} (repo+origin+upstream+dirty) and ${GIT_NR.split('/').pop()} (repo, clean, no remote)`);

  /* A stub `claude` so nothing reaches the network if an account path is hit. */
  fs.writeFileSync(path.join(BIN, 'claude'), [
    '#!/bin/sh',
    'if [ "$2" = "status" ]; then echo \'{"loggedIn":false}\'; exit 1; fi',
    'echo "https://example.invalid/cai/oauth/authorize?code=stub&state=stub"',
    'cat > /dev/null',
  ].join('\n') + '\n', { mode: 0o755 });

  const port = await freePort();
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: `${BIN}:${process.env.PATH}`,
      PORT: String(port), HOST: '127.0.0.1',
      CLAUDE_STATION_DATA: DATA, CLAUDE_CONFIG_DIR: CFG, CLAUDE_PROJECTS_DIR: STORE,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  procs.push(server);
  server.stderr?.on('data', (dd) => { const s = String(dd); if (/error|Error/.test(s)) process.stderr.write(`  [srv!] ${s}`); });
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 200 && !up; i++) { try { await fetch(`${base}/api/health`); up = true; } catch { await sleep(250); } }
  check('the real server booted and answers /api/health', up, base);
  if (!up) throw new Error('server never became healthy');

  const mk = async (hostPath, name) => {
    const r = await (await fetch(`${base}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostPath, name, applyMethod: false }),
    })).json();
    return r.project?.id;
  };
  const directId = await mk(DIRECT, 'direct proj');
  const containerId = await mk(CONTAINER, 'container proj');
  const goneId = await mk(GONE, 'vanished proj');
  await fetch(`${base}/api/projects/${containerId}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    /* `/workspace` is where the project directory itself is already bound, and
       the server refuses to mount over it — a mount aimed there is rejected,
       which takes the whole PATCH (isolation included) with it. This fixture
       asked for exactly that until round 5, so it had never actually rendered
       a mount ROW. An extra mount needs its own container path. */
    body: JSON.stringify({ isolation: 'container', mounts: [{ hostPath: DIRECT, containerPath: '/mnt/extra', readOnly: true }] }),
  });
  await fetch(`${base}/api/projects/${directId}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ isolation: 'direct' }),
  });
  /* Round 5 — the shape fixtures, registered and shaped through the real API. */
  const patch = async (id, body) => (await (await fetch(`${base}/api/projects/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })).json());
  const gitUpId = await mk(GIT_UP, 'git tracking proj');
  const gitNrId = await mk(GIT_NR, 'git local proj');
  const sandboxId = await mk(SANDBOX, 'sandbox proj');
  const cbareId = await mk(CBARE, 'bare container proj');
  const snapId = await mk(SNAPP, 'snapshot proj');
  for (const id of [gitUpId, gitNrId, snapId]) await patch(id, { isolation: 'direct' });
  await patch(sandboxId, { isolation: 'sandbox' });
  await patch(cbareId, { isolation: 'container', settings: { mounts: [], services: [] } });
  await patch(containerId, { settings: { services: [{ name: 'redis', image: 'redis:7-alpine', env: [], dataPath: null }] } });
  await patch(snapId, { settings: { snapshots: { enabled: true } } });

  const cProj = await (await fetch(`${base}/api/projects/${containerId}`)).json();
  const dProj = await (await fetch(`${base}/api/projects/${directId}`)).json();
  check('PRECONDITION: one container project and one direct project, as reported by the server',
    (cProj.project ?? cProj)?.isolation === 'container' && (dProj.project ?? dProj)?.isolation === 'direct',
    `container=${(cProj.project ?? cProj)?.isolation} direct=${(dProj.project ?? dProj)?.isolation}`);

  // ── browser ──
  const profile = path.join(tmp, 'chrome');
  fs.mkdirSync(profile, { recursive: true });
  browser = spawn(BRAVE, [
    '--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', '--window-size=1400,1000', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  procs.push(browser);
  let devPort = 0;
  for (let i = 0; i < 160 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  if (!devPort) throw new Error('browser never wrote DevToolsActivePort');
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  cdp = await Cdp.connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  cdp.on('Runtime.exceptionThrown', (p) => consoleErrors.push(`exception: ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text}`));
  cdp.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') consoleErrors.push(`console.error: ${(p.args ?? []).map((a) => a.value ?? a.description).join(' ')}`); });
  cdp.on('Log.entryAdded', (p) => { if (p.entry?.level === 'error') consoleErrors.push(`log: ${p.entry.text}`); });
  await cdp.viewport(1400, 1000);

  const goto = async (id) => {
    await cdp.send('Page.navigate', { url: 'about:blank' });
    await sleep(120);
    await cdp.send('Page.navigate', { url: `${base}/#/project/${encodeURIComponent(id)}` });
    await cdp.waitFor('app boot', `!!(window.__station && window.__station.drawer)`);
    const right = await cdp.waitFor('the right project selected',
      `window.__station.currentProject()?.id === ${JSON.stringify(id)}`);
    check(`PRECONDITION: the page is really showing project ${id.slice(0, 8)}…`, right === true, String(right));
    await sleep(300);
  };
  const closeIt = async () => { await cdp.eval(`(() => { const D = window.__station.drawer; D.close(); D.close(); })()`); await sleep(120); };

  /* A REAL second Claude account, created through the product's own route. It
     has to be real: the server refuses `settings.claudeAccount` unless the id
     names an account that exists right now (validate.ts), which is exactly the
     guard a client-side fixture would have hidden. */
  const acctRes = await (await fetch(`${base}/api/claude-accounts`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'Work Max' }),
  })).json();
  const WORK_ID = acctRes.account?.id ?? acctRes.id ?? null;
  check('PRECONDITION: a REAL second Claude account exists on the server (not a client-side fixture)',
    typeof WORK_ID === 'string' && WORK_ID.length > 0, String(WORK_ID));

  /* The plan + login state the CLI would have reported for it once signed in.
     The account LIST has one owner (app.js) since this ticket, so seeding it
     there is what every reader — including the settings modal — now sees. */
  const seedAccounts = async (pending = false) => {
    await cdp.eval(`(() => {
      window.__station.setAccountsForTest([
        { id: 'default', label: 'Default (~/.claude)', state: 'ready', lastStatus: { subscriptionType: 'pro' } },
        { id: ${JSON.stringify(WORK_ID)}, label: 'Work Max', state: ${pending ? "'pending'" : "'ready'"}, lastStatus: { subscriptionType: 'max' } },
      ]);
    })()`);
  };
  /* The per-account 5-hour window, seeded into the same state field the usage
     poll fills (resetsAt is epoch SECONDS, the shape /api/usage reports) — the
     harness has no live provider to read one from. */
  const seedUsage = async () => {
    await cdp.eval(`(() => {
      const soon = Math.round(Date.now() / 1000) + 3600;
      window.__station.state.usage = [
        { provider: 'anthropic', accountId: 'default', accountLabel: 'Default', available: true, asOf: Date.now(),
          windows: [{ label: '5-hour', usedPercent: 12, binding: true, resetsAt: soon }] },
        { provider: 'anthropic', accountId: ${JSON.stringify(WORK_ID)}, accountLabel: 'Work Max', available: true, asOf: Date.now(),
          windows: [{ label: '5-hour', usedPercent: 71, binding: true, resetsAt: soon + 1800 }] },
      ];
    })()`);
  };

  await cdp.theme('dark');
  await goto(containerId);
  await seedAccounts();
  await seedUsage();
  consoleErrors = [];

  /* ══════════ 1. COMPLETENESS — nothing was silently dropped ══════════ */
  section('1. completeness: every pre-redesign control is still rendered, by exactly one category');
  const sweep = await cdp.eval(SWEEP);
  const flagsSeen = new Map();   // flag -> [categories that render it]
  for (const [catg, r] of Object.entries(sweep)) {
    for (const f of r.flags) {
      if (!flagsSeen.has(f)) flagsSeen.set(f, []);
      if (!flagsSeen.get(f).includes(catg)) flagsSeen.get(f).push(catg);
    }
  }
  const missingFlags = Object.keys(FLAG_INVENTORY).filter((f) => !flagsSeen.has(f));
  check('all 16 flagged rows from the pinned pre-redesign inventory (dc1f4ea) are still on screen somewhere',
    missingFlags.length === 0,
    missingFlags.length ? `MISSING: ${missingFlags.join(' | ')}` : `${Object.keys(FLAG_INVENTORY).length}/16 present`);
  const wrongHome = Object.entries(FLAG_INVENTORY)
    .filter(([f, catg]) => flagsSeen.has(f) && !flagsSeen.get(f).includes(catg))
    .map(([f, catg]) => `${f}: expected ${catg}, found ${flagsSeen.get(f).join('+')}`);
  check('each flagged row is rendered by the category the redesign assigned it to (still writing the same key)',
    wrongHome.length === 0, wrongHome.length ? wrongHome.join(' | ') : 'every flag in its assigned category');
  const duped = [...flagsSeen.entries()].filter(([, cats]) => cats.length > 1).map(([f, cats]) => `${f} → ${cats.join('+')}`);
  check('no flagged row is rendered by TWO categories (the re-home left no duplicate surface)',
    duped.length === 0, duped.length ? duped.join(' | ') : 'every flag appears in exactly one category');

  const controlMiss = [];
  const controlDupe = [];
  for (const [label, catg, sel] of CONTROL_INVENTORY) {
    const homes = Object.entries(sweep).filter(([, r]) => r.controls.includes(label)).map(([k]) => k);
    if (!homes.includes(catg)) controlMiss.push(`${label} (expected ${catg}, found ${homes.join('+') || 'nowhere'}) [${sel}]`);
    else if (homes.length > 1) controlDupe.push(`${label} → ${homes.join('+')}`);
  }
  check(`all ${CONTROL_INVENTORY.length} unflagged controls are reachable in their assigned category`,
    controlMiss.length === 0, controlMiss.length ? controlMiss.join(' | ') : CONTROL_INVENTORY.map(([l]) => l).join(', '));
  check('no unflagged control is rendered by two categories either',
    controlDupe.length === 0, controlDupe.length ? controlDupe.join(' | ') : 'none duplicated');

  /* ══════════ 2. the two-directional category assertion ══════════ */
  section('2. each category renders its OWN cards and NOT another category\'s');
  for (const id of RAIL_IDS) {
    const r = sweep[id];
    const own = r.markers.includes(id);
    const foreign = r.markers.filter((m) => m !== id);
    check(`"${id}" renders its own marker and none of the other ten`,
      own && foreign.length === 0, `markers=${JSON.stringify(r.markers)} cards=${r.cards}`);
  }
  const before = await cdp.eval(`(() => {
    // The seam phase 1 left: every project category rendered the WHOLE of
    // settingsView(). If it were still there, one category would carry them all.
    return null; })()`);
  void before;
  const totalMarkers = Object.values(sweep).reduce((n, r) => n + r.markers.length, 0);
  check('the phase-1 seam is closed: 11 categories carry 11 markers between them, not 11 each',
    totalMarkers === RAIL_IDS.length, `${totalMarkers} markers across ${RAIL_IDS.length} categories`);

  /* A look at the densest categories, so "it renders" is backed by a picture a
     human can judge and not only by a DOM assertion. */
  for (const id of ['isolation', 'snapshots', 'workspace', 'advanced', 'accounts']) {
    await cdp.eval(`(async () => { const D = window.__station.drawer; D.close(); D.close(); await D.open('settings');
      document.querySelector('.srail-item[data-cat="${id}"]').click(); })()`);
    await sleep(1400);
    await shot(`feat146b-cat-${id}.png`, 3);
  }
  await closeIt();

  /* ══════════ 3. the anchors phase 2 re-homed ══════════ */
  section('3. the anchors this phase moved still resolve, scroll and flash');
  const DEEP = (key) => `(async () => {
    const D = window.__station.drawer;
    D.close(); D.close();
    await D.open('settings', { focus: ${JSON.stringify(key)} });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const pane = document.querySelector('#dBody');
    const q = () => { const h = document.querySelector('.view.on');
      return h ? (h.querySelector('[data-focus="' + ${JSON.stringify(key)} + '"]') ?? h.querySelector('details[data-sect="' + ${JSON.stringify(key)} + '"]')) : null; };
    const topOf = (t) => t ? Math.round(t.getBoundingClientRect().top - pane.getBoundingClientRect().top) : null;
    const paneH = Math.round(pane.getBoundingClientRect().height);
    const target = q();
    const flashed = target ? target.classList.contains('focus-flash') : false;
    const topNow = topOf(target);
    await new Promise((r) => setTimeout(r, 900));
    const topLater = topOf(q());
    return { cat: document.querySelector('.srail-item[aria-current="page"]')?.dataset.cat ?? null,
      found: !!target, flashed, topNow, topLater, paneH,
      inView: [topNow, topLater].some((t) => t !== null && t >= -4 && t < paneH), open: D.isOpen() };
  })()`;
  for (const [key, catg] of Object.entries(MOVED_ANCHORS)) {
    const r = await cdp.eval(DEEP(key));
    check(`"${key}" → category ${catg}, anchor found, flashed, in view`,
      r.open && r.cat === catg && r.found && r.flashed && r.inView, JSON.stringify(r));
  }

  /* ══════════ 4. the project-scope Claude account control ══════════ */
  section('4. the project-scope Claude account control (the FEAT-145 gap)');
  await closeIt();
  await cdp.eval(`window.__station.drawer.open('settings', { focus: 'projectAccount' })`);
  await cdp.waitFor('account control', `!!document.querySelector('#pAccountSel')`, 10000);
  const ctl = await cdp.eval(`(() => {
    const s = document.querySelector('#pAccountSel');
    return { opts: [...s.options].map((o) => ({ v: o.value, t: o.textContent, sel: o.selected })),
      disabled: s.disabled, lens: window.__station.drawer.scope() };
  })()`);
  check('PRECONDITION: the control is on screen under the project lens on a CONTAINER project',
    ctl.lens === 'project' && ctl.disabled === false && ctl.opts.length >= 2, JSON.stringify(ctl.opts.map((o) => o.v)));
  const work = ctl.opts.find((o) => o.v === WORK_ID);
  check('each account shows its label, its plan/login state and its OWN remaining 5-hour window',
    !!work && /Work Max/.test(work.t) && /max/.test(work.t) && /logged in/.test(work.t) && /71% of 5-hour/.test(work.t),
    work ? work.t : 'no second-account option');

  const regBeforeAcct = await (await fetch(`${base}/api/projects/${containerId}`)).json();
  await cdp.eval(`(() => { const s = document.querySelector('#pAccountSel'); s.value = ${JSON.stringify(WORK_ID)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(800);
  const regAfterAcct = await (await fetch(`${base}/api/projects/${containerId}`)).json();
  check('picking an account WRITES settings.claudeAccount at PROJECT scope (read back from the server)',
    ((regBeforeAcct.project ?? regBeforeAcct)?.settings?.claudeAccount ?? null) === null
      && (regAfterAcct.project ?? regAfterAcct)?.settings?.claudeAccount === WORK_ID,
    `${JSON.stringify((regBeforeAcct.project ?? regBeforeAcct)?.settings?.claudeAccount ?? null)} → ${JSON.stringify((regAfterAcct.project ?? regAfterAcct)?.settings?.claudeAccount ?? null)}`);

  await cdp.eval(`(() => { const s = document.querySelector('#pAccountSel'); s.value = '__inherit__'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(800);
  const regCleared = await (await fetch(`${base}/api/projects/${containerId}`)).json();
  check('"Machine default" clears it back to null (never the "default" sentinel the server would reject)',
    ((regCleared.project ?? regCleared)?.settings?.claudeAccount ?? null) === null,
    JSON.stringify((regCleared.project ?? regCleared)?.settings?.claudeAccount ?? null));

  // Under the SESSION lens on a CONTAINER project: locked, reason on screen.
  await cdp.eval(`document.querySelector('#dScope button[data-scope="session"]').click()`);
  await sleep(500);
  const lockedState = await cdp.eval(`(() => {
    const s = document.querySelector('#pAccountSel');
    const grp = document.querySelector('.view.on [data-focus="projectAccount"]');
    const warn = grp ? grp.querySelector('[data-warn="true"]') : null;
    const shown = warn ? warn.textContent : '';
    return { present: !!s, disabled: s ? s.disabled : null, reasonShown: shown,
      matchesOwner: shown.trim() === (window.__station.accountLockedReason() || '').trim(),
      visible: warn ? warn.checkVisibility({ checkVisibilityCSS: true }) : false };
  })()`);
  check('session lens + container project: the control is PRESENT but locked, with the reason visible on screen',
    lockedState.present && lockedState.disabled === true && lockedState.visible && lockedState.reasonShown.length > 40,
    JSON.stringify({ present: lockedState.present, disabled: lockedState.disabled, visible: lockedState.visible, reason: lockedState.reasonShown.slice(0, 80) }));
  check('the locked reason is app.js\'s accountLockedReason() VERBATIM — not a second phrasing of the same refusal',
    lockedState.matchesOwner === true, `matches owner = ${lockedState.matchesOwner}`);

  const wroteNothing = await cdp.eval(`(async () => {
    const s = document.querySelector('#pAccountSel');
    const ovrBefore = JSON.stringify(window.__station.state.overrides);
    s.value = ${JSON.stringify(WORK_ID)};
    s.dispatchEvent(new Event('change', { bubbles: true }));   // a disabled select must not write
    await new Promise((r) => setTimeout(r, 600));
    return { ovrBefore, ovrAfter: JSON.stringify(window.__station.state.overrides) };
  })()`);
  const regLocked = await (await fetch(`${base}/api/projects/${containerId}`)).json();
  check('and it writes NOTHING: no session override armed, and the registry is untouched',
    wroteNothing.ovrBefore === wroteNothing.ovrAfter
      && !/claudeAccount/.test(wroteNothing.ovrAfter)
      && ((regLocked.project ?? regLocked)?.settings?.claudeAccount ?? null) === null,
    JSON.stringify({ ...wroteNothing, registry: (regLocked.project ?? regLocked)?.settings?.claudeAccount ?? null }));

  // On a DIRECT project the session lens is a real per-launch override.
  await closeIt();
  await goto(directId);
  await seedAccounts();
  await seedUsage();
  await cdp.eval(`window.__station.drawer.open('settings', { focus: 'projectAccount' })`);
  await cdp.waitFor('account control', `!!document.querySelector('#pAccountSel')`, 10000);
  await cdp.eval(`document.querySelector('#dScope button[data-scope="session"]').click()`);
  await sleep(400);
  const sessionPick = await cdp.eval(`(async () => {
    const s = document.querySelector('#pAccountSel');
    const disabled = s.disabled;
    s.value = ${JSON.stringify(WORK_ID)};
    s.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    return { disabled, override: window.__station.state.overrides.claudeAccount ?? null,
      armedKey: 'claudeAccount' in window.__station.state.overrides };
  })()`);
  const regDirect = await (await fetch(`${base}/api/projects/${directId}`)).json();
  check('on a DIRECT project the session lens arms the per-launch override instead — and still writes no registry value',
    sessionPick.disabled === false && sessionPick.armedKey === true && sessionPick.override === WORK_ID
      && ((regDirect.project ?? regDirect)?.settings?.claudeAccount ?? null) === null,
    JSON.stringify({ ...sessionPick, registry: (regDirect.project ?? regDirect)?.settings?.claudeAccount ?? null }));

  /* ══════════ 5. rail dots against their real conditions ══════════ */
  section('5. rail dots light for a real condition and CLEAR when it resolves');
  const dotOf = (id) => cdp.eval(`(document.querySelector('.srail-item[data-cat="${id}"]')?.dataset.dot ?? null)`);

  // (a) an account that was added but never signed in — needs you.
  await closeIt();
  await seedAccounts(true);
  await cdp.eval(`window.__station.drawer.open('settings')`);
  await sleep(600);
  const dotAcctWarn = await dotOf('accounts');
  await seedAccounts(false);
  await cdp.eval(`window.__station.drawer.repaint()`);
  await sleep(600);
  const dotAcctClear = await dotOf('accounts');
  check('Accounts: --warn while an account is "not signed in yet", and CLEARS once it is ready',
    dotAcctWarn === 'warn' && dotAcctClear === null, `pending=${dotAcctWarn} ready=${dotAcctClear}`);

  // (b) an OAuth login in flight.
  const dotLogin = await cdp.eval(`(async () => {
    const D = window.__station.drawer;
    document.querySelector('.srail-item[data-cat="accounts"]').click();
    await new Promise((r) => setTimeout(r, 400));
    const add = document.querySelector('#gAcctAdd');
    if (!add) return { skipped: 'no add button' };
    add.click();
    await new Promise((r) => setTimeout(r, 200));
    const i = document.querySelector('#gAcctLabel');
    i.value = 'verify stub'; i.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#gAcctCreate').click();
    for (let n = 0; n < 60 && !document.querySelector('#gAcctCancel'); n++) await new Promise((r) => setTimeout(r, 250));
    const inFlight = document.querySelector('.srail-item[data-cat="accounts"]').dataset.dot ?? null;
    document.querySelector('#gAcctCancel')?.click();
    await new Promise((r) => setTimeout(r, 1500));
    void D;
    return { inFlight, hadPanel: true };
  })()`);
  check('Accounts: --warn while a REAL OAuth sign-in is in flight (product login relay, stubbed CLI)',
    dotLogin.inFlight === 'warn', JSON.stringify(dotLogin));

  // (c) a failed start snapshot — the session that is on screen has no restore point.
  await closeIt();
  await cdp.eval(`(() => { window.__station.state.startSnapshot = { status: 'failed', error: 'stubbed for this check' }; })()`);
  await cdp.eval(`window.__station.drawer.open('settings')`);
  await sleep(700);
  const dotSnapWarn = await dotOf('snapshots');
  await cdp.eval(`(() => { window.__station.state.startSnapshot = null; window.__station.drawer.repaint(); })()`);
  await sleep(700);
  const dotSnapClear = await dotOf('snapshots');
  check('Snapshots: --warn for a FAILED start snapshot, and clears when there is no failure',
    dotSnapWarn === 'warn' && dotSnapClear === null, `failed=${dotSnapWarn} cleared=${dotSnapClear}`);

  // (d) a live session under the session lens.
  await cdp.eval(`(() => { window.__station.state.effective = { overridden: [], effective: {} }; })()`);
  await cdp.eval(`document.querySelector('#dScope button[data-scope="session"]').click()`);
  await sleep(400);
  const dotLive = await dotOf('model');
  await cdp.eval(`document.querySelector('#dScope button[data-scope="project"]').click()`);
  await sleep(400);
  const dotLiveOff = await dotOf('model');
  await cdp.eval(`(() => { window.__station.state.effective = null; })()`);
  check('Model & spend: --live for a live session UNDER THE SESSION LENS, and not under the project lens',
    dotLive === 'live' && dotLiveOff === null, `session=${dotLive} project=${dotLiveOff}`);

  // (e) a missing host directory.
  await closeIt();
  fs.rmSync(GONE, { recursive: true, force: true });
  await goto(goneId);
  const pathGone = await cdp.eval(`window.__station.currentProject()?.pathMissing === true`);
  check('PRECONDITION: the server really reports the vanished project as pathMissing',
    pathGone === true, String(pathGone));
  await cdp.eval(`window.__station.drawer.open('settings')`);
  await sleep(900);
  const dotDirWarn = await dotOf('workspace');
  check('Workspace: --warn when the project\'s host directory is gone',
    dotDirWarn === 'warn', String(dotDirWarn));

  // (f) a real process running out of the project directory → live, then clears.
  await closeIt();
  await goto(directId);
  const liveProc = spawn('sleep', ['120'], { cwd: DIRECT, stdio: 'ignore' });
  procs.push(liveProc);
  await sleep(600);
  await cdp.eval(`window.__station.drawer.open('settings')`);
  await cdp.waitFor('processes read', `Array.isArray(window.__station.state.projects) && !document.querySelector('#smodal').hidden`, 8000);
  await sleep(2500);
  const dotProcLive = await dotOf('workspace');
  stopByPid(liveProc);
  await sleep(1200);
  await cdp.eval(`window.__station.drawer.repaint()`);
  await sleep(2500);
  const dotProcClear = await dotOf('workspace');
  check('Workspace: --live while a REAL process runs out of the project directory, and clears when it exits',
    dotProcLive === 'live' && dotProcClear === null, `running=${dotProcLive} gone=${dotProcClear}`);

  /* ══════════ 6. the two grouping defects ══════════ */
  section('6. the grouping defects the inventory named');
  await closeIt();
  await cdp.eval(`window.__station.drawer.open('instructions', 'settings')`);
  await cdp.waitFor('stack', `!!document.querySelector('#vInstructions .trow')`, 10000);
  const grip = await cdp.eval(`(() => ({
    grips: document.querySelectorAll('#vInstructions .trow .grip').length,
    liars: [...document.querySelectorAll('#vInstructions [title]')].filter((n) => /reorder/.test(n.title) && !n.matches('button')).length,
    arrows: document.querySelectorAll('#vInstructions .trow .arrows button').length,
    draggable: document.querySelectorAll('#vInstructions .trow [draggable="true"]').length,
  }))()`);
  check('the non-draggable "⠿" drag handle is gone; the ▲/▼ arrows are the real reorder control',
    grip.grips === 0 && grip.liars === 0 && grip.arrows > 0, JSON.stringify(grip));

  await closeIt();
  await cdp.eval(`window.__station.drawer.open('settings', { focus: 'instructions' })`);
  await sleep(600);
  const instrScope = await cdp.eval(`(() => ({
    cat: document.querySelector('.srail-item[aria-current="page"]')?.dataset.cat,
    hint: document.querySelector('#dHint').textContent,
    lensHidden: document.querySelector('#dScope').hidden,
    lensButtons: [...document.querySelectorAll('#dScope [data-scope]')].map((b) => b.dataset.scope),
  }))()`);
  check('Instructions no longer offers a machine scope it never honoured: the lens is project/session only, and the hint says so',
    instrScope.cat === 'instructions' && instrScope.lensHidden === false
      && JSON.stringify(instrScope.lensButtons) === '["project","session"]'
      && /this project/i.test(instrScope.hint) && !/every project on this machine/i.test(instrScope.hint),
    JSON.stringify(instrScope));

  /* ══════════ 7. widths and themes ══════════ */
  section('7. every category renders at three widths in both themes, zero console errors');
  await closeIt();
  consoleErrors = [];
  for (const [w, h, label] of [[940, 780, '940'], [800, 780, '800'], [500, 820, '500']]) {
    await cdp.viewport(w, h);
    await sleep(250);
    for (const tone of ['light', 'dark']) {
      await cdp.theme(tone);
      const geo = await cdp.eval(`(async () => {
        const D = window.__station.drawer;
        const bad = [];
        for (const id of ${JSON.stringify(RAIL_IDS)}) {
          D.close(); D.close();
          await D.open('settings');
          document.querySelector('.srail-item[data-cat="' + id + '"]').click();
          await new Promise((r) => setTimeout(r, 260));
          const pane = document.querySelector('#dBody');
          const box = document.querySelector('.smodal-box').getBoundingClientRect();
          if (pane.scrollWidth > pane.clientWidth + 1) bad.push(id + ':clipped');
          if (box.right > innerWidth + 1 || box.bottom > innerHeight + 1) bad.push(id + ':overflow');
          if (!document.querySelector('#dBody .view.on').children.length) bad.push(id + ':empty');
        }
        D.close(); D.close();
        return bad;
      })()`);
      check(`${label}px / ${tone}: all 11 categories render non-empty, unclipped, inside the viewport`,
        geo.length === 0, geo.length ? geo.join(' | ') : 'all 11 clean');
    }
    await cdp.eval(`window.__station.drawer.open('settings')`);
    await sleep(300);
    await shot(`feat146b-${label}.png`, 3);
    await closeIt();
  }
  await cdp.viewport(1400, 1000);
  check('zero console errors across every category, width and theme',
    consoleErrors.length === 0, consoleErrors.length ? consoleErrors.slice(0, 6).join(' | ') : 'none');

  /* ══════════ 8. SHAPE completeness ══════════
   * The clean-room round's named could-not-test. Every fixture above — the
   * authors' and the independent verifier's — is one project shape: non-git,
   * snapshot-less, container-or-direct, two accounts, no live session. These
   * are the shapes nothing had ever painted. */
  section('8. SHAPE completeness: the project shapes no fixture used to build');
  await closeIt();
  await cdp.theme('dark');

  /* Two real snapshots on the snapshot project, taken through the product's own
     route — a client-side fixture would not have exercised the store at all. */
  const snapTake = async (label) => (await (await fetch(`${base}/api/projects/${snapId}/snapshots`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label }),
  })).json());
  fs.writeFileSync(path.join(SNAPP, 'one.txt'), 'one\n');
  const snapA = await snapTake('fixture A');
  fs.writeFileSync(path.join(SNAPP, 'two.txt'), 'two\n');
  const snapB = await snapTake('fixture B');
  const snapList = await (await fetch(`${base}/api/projects/${snapId}/snapshots`)).json();
  check('PRECONDITION: two REAL snapshots exist on the server for the snapshot-shaped project',
    (snapList.snapshots ?? []).length === 2,
    `${(snapList.snapshots ?? []).length} snapshots · ${[snapA, snapB].map((s) => s.snapshot?.fileCount ?? '?').join('/')} files`);
  const shapeProjects = await Promise.all([sandboxId, cbareId, gitUpId, containerId].map(async (id) => {
    const r = await (await fetch(`${base}/api/projects/${id}`)).json();
    return (r.project ?? r);
  }));
  check('PRECONDITION: the server really stores the four project shapes (sandbox tier / bare container / git repo / container with a mount and a service)',
    shapeProjects[0].isolation === 'sandbox' && shapeProjects[1].isolation === 'container'
      && (shapeProjects[1].settings?.mounts ?? []).length === 0
      && (shapeProjects[1].settings?.services ?? []).length === 0
      && shapeProjects[2].isolation === 'direct'
      && (shapeProjects[3].settings?.mounts ?? []).length === 1
      && (shapeProjects[3].settings?.services ?? []).length === 1,
    JSON.stringify(shapeProjects.map((p) => ({ iso: p.isolation, mounts: (p.settings?.mounts ?? []).length, services: (p.settings?.services ?? []).length }))));

  /* One Fetch.requestPaused handler for the whole run: two sections need
     interception and two handlers would both try to answer the same
     requestId. An override list is consulted; everything else continues. */
  const overrides = [];
  let fetchArmed = false;
  cdp.on('Fetch.requestPaused', (p) => {
    const hit = overrides.find((o) => o.test(p.request.url));
    if (!hit) { cdp.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {}); return; }
    cdp.send('Fetch.fulfillRequest', {
      requestId: p.requestId, responseCode: 200,
      responseHeaders: [{ name: 'content-type', value: hit.mime }],
      body: Buffer.from(hit.body, 'utf8').toString('base64'),
    }).catch(() => {});
  });
  const armFetch = async (patterns) => { await cdp.send('Fetch.enable', { patterns }); fetchArmed = true; };
  const disarmFetch = async () => { overrides.length = 0; if (fetchArmed) await cdp.send('Fetch.disable'); fetchArmed = false; };

  /* The accounts shape: seeded through app.js, the ONE owner of the list. */
  const seedDefaultOnly = async () => {
    await cdp.eval(`window.__station.setAccountsForTest([
      { id: 'default', label: 'Default (~/.claude)', state: 'ready', lastStatus: { subscriptionType: 'pro' } }])`);
  };

  const GIT_REPO_BASE = { 'iso.directOn': 'isolation', 'iso.unheld': 'isolation', 'snap.take': 'snapshots', 'snap.empty': 'snapshots' };
  const NO_REPO = { 'git.init': 'workspace', 'git.terminal': 'workspace', 'git.notrepo': 'workspace' };
  const TWO_ACCOUNTS = { 'acct.projectSel': 'model', 'acct.globalSel': 'accounts', 'acct.add': 'accounts' };
  const CONTAINER_BASE = {
    'iso.containerOn': 'isolation', 'iso.access': 'isolation', 'iso.addMount': 'isolation', 'iso.socket': 'isolation',
    'svc.card': 'isolation', 'svc.add': 'isolation',
    'snap.take': 'snapshots', 'snap.empty': 'snapshots',
  };

  const SHAPES = [
    {
      id: 'git repo · remote · upstream · dirty', pid: gitUpId, scope: 'project', shot: 'feat146b-shape-git.png',
      expect: {
        'git.status': 'workspace', 'git.review': 'workspace', 'git.push': 'workspace', 'git.pull': 'workspace',
        'git.refresh': 'workspace', 'git.terminal': 'workspace',
        ...GIT_REPO_BASE, ...TWO_ACCOUNTS,
      },
    },
    {
      id: 'git repo · no remote · clean', pid: gitNrId, scope: 'project',
      expect: {
        'git.status': 'workspace', 'git.workbench': 'workspace', 'git.create': 'workspace',
        'git.refresh': 'workspace', 'git.terminal': 'workspace',
        ...GIT_REPO_BASE, ...TWO_ACCOUNTS,
      },
    },
    {
      id: 'not a git repository at all', pid: directId, scope: 'project',
      expect: { ...NO_REPO, ...GIT_REPO_BASE, ...TWO_ACCOUNTS },
    },
    {
      id: 'isolation: sandbox — the third tier no fixture built', pid: sandboxId, scope: 'project', shot: 'feat146b-shape-sandbox.png',
      expect: {
        'iso.sandboxOn': 'isolation', 'iso.confined': 'isolation',
        'snap.take': 'snapshots', 'snap.empty': 'snapshots',
        ...NO_REPO, ...TWO_ACCOUNTS,
      },
    },
    {
      id: 'container with NEITHER mounts nor services (the empty states)', pid: cbareId, scope: 'project',
      expect: { ...CONTAINER_BASE, 'svc.empty': 'isolation', ...NO_REPO, ...TWO_ACCOUNTS },
      gated: [...CONTAINER_FLAGS, ...SNAPON_FLAGS],
    },
    {
      id: 'container WITH a mount and a service', pid: containerId, scope: 'project',
      expect: { ...CONTAINER_BASE, 'iso.mountRow': 'isolation', 'svc.row': 'isolation', ...NO_REPO, ...TWO_ACCOUNTS },
      gated: [...CONTAINER_FLAGS, ...SNAPON_FLAGS],
    },
    {
      id: 'snapshots PRESENT (two real ones)', pid: snapId, scope: 'project', shot: 'feat146b-shape-snapshots.png',
      expect: {
        'snap.row': 'snapshots', 'snap.restore': 'snapshots', 'snap.delete': 'snapshots', 'snap.take': 'snapshots',
        'iso.directOn': 'isolation', 'iso.unheld': 'isolation', ...NO_REPO, ...TWO_ACCOUNTS,
      },
      gated: SNAPON_FLAGS,
    },
    {
      id: 'snapshots present AND both failure channels reporting', pid: snapId, scope: 'project', shot: 'feat146b-shape-snapfail.png',
      /* liveFailureNote() is driven by the session's own start-snapshot report
         (the shape the server's session events carry). failureNote() is driven
         by a `failures` array on the list response — a shape `api.js`
         explicitly reads but the current server never emits, so it is injected
         over CDP onto the REAL list body rather than invented wholesale. */
      before: async () => {
        const real = await (await fetch(`${base}/api/projects/${snapId}/snapshots`)).json();
        overrides.push({
          test: (u) => u.includes(`/${snapId}/snapshots`),
          mime: 'application/json',
          body: JSON.stringify({
            ...real,
            failures: [{ id: 'fixture-failed-1', createdAt: new Date().toISOString(), reason: 'session-start', status: 'failed', error: 'cp failed with exit 1 (fixture)' }],
          }),
        });
        await armFetch([{ urlPattern: '*/snapshots', requestStage: 'Request' }]);
        await cdp.eval(`(() => { window.__station.state.startSnapshot = { status: 'failed', error: 'the start snapshot did not complete (fixture)' }; })()`);
      },
      after: async () => {
        await disarmFetch();
        await cdp.eval(`(() => { window.__station.state.startSnapshot = null; })()`);
      },
      expect: {
        'snap.row': 'snapshots', 'snap.restore': 'snapshots', 'snap.delete': 'snapshots', 'snap.take': 'snapshots',
        'snap.failedRow': 'snapshots', 'snap.failNote': 'snapshots', 'snap.liveFail': 'snapshots',
        'iso.directOn': 'isolation', 'iso.unheld': 'isolation', ...NO_REPO, ...TWO_ACCOUNTS,
      },
      gated: SNAPON_FLAGS,
    },
    {
      id: 'only the DEFAULT Claude account (no second subscription)', pid: gitNrId, scope: 'project',
      accounts: 'default-only',
      expect: {
        'acct.onlyRow': 'model', 'acct.onlyDoor': 'model', 'acct.globalOnly': 'accounts', 'acct.add': 'accounts',
        'git.status': 'workspace', 'git.workbench': 'workspace', 'git.create': 'workspace',
        'git.refresh': 'workspace', 'git.terminal': 'workspace', ...GIT_REPO_BASE,
      },
    },
  ];

  for (const sh of SHAPES) {
    await closeIt();
    await goto(sh.pid);
    if (sh.accounts === 'default-only') await seedDefaultOnly(); else await seedAccounts();
    await seedUsage();
    if (sh.before) await sh.before();
    const sweep2 = await cdp.eval(SHAPE_SWEEP(sh.scope));
    const r = gradeShape(sweep2, { expect: sh.expect, gated: sh.gated ?? [] });
    const seen = Object.keys(sh.expect).length - r.missing.length;
    check(`shape "${sh.id}": every control this shape makes reachable IS reachable`,
      r.missing.length === 0,
      r.missing.length ? `MISSING (dropped on this shape only): ${r.missing.join(' | ')}` : `${seen}/${Object.keys(sh.expect).length} present`);
    check(`shape "${sh.id}": each sits in its assigned category, in EXACTLY one`,
      r.misplaced.length === 0 && r.duplicated.length === 0,
      [...r.misplaced, ...r.duplicated].join(' | ') || 'every control in one category, the assigned one');
    check(`shape "${sh.id}": and nothing this shape must NOT offer is on screen`,
      r.unexpected.length === 0,
      r.unexpected.length ? `UNEXPECTED: ${r.unexpected.join(' | ')}` : 'no control from another shape leaked in');
    check(`shape "${sh.id}": the shape-independent rows all survive, and a gated row appears only where the shape earns it`,
      r.flagMissing.length === 0 && r.flagExtra.length === 0,
      [...r.flagMissing.map((f) => `missing ${f}`), ...r.flagExtra.map((f) => `unearned ${f}`)].join(' | ')
        || `${ALWAYS_FLAGS.length} always-rows + ${(sh.gated ?? []).length} gated`);
    if (sh.shot) {
      const cat = sh.shot.includes('git') ? 'workspace' : sh.shot.includes('snap') ? 'snapshots' : 'isolation';
      await cdp.eval(`(async () => { const D = window.__station.drawer; D.close(); D.close();
        await D.open('settings'); document.querySelector('.srail-item[data-cat="${cat}"]').click(); })()`);
      await sleep(1500);
      await shot(sh.shot, 3);
      await closeIt();
    }
    if (sh.after) await sh.after();
  }

  /* ══════════ 9. a live session, under BOTH lenses ══════════ */
  section('9. a live session vs none, under both lens positions');
  await closeIt();
  await goto(directId);
  await seedAccounts();
  const liveLine = async (scope) => cdp.eval(`(async () => {
    const D = window.__station.drawer;
    D.close(); D.close();
    await D.open('settings', { scope: ${JSON.stringify(scope)} });
    await new Promise((r) => setTimeout(r, 400));
    const n = document.querySelector('#dLive');
    return { hidden: n.hidden, text: (n.textContent || '').trim(),
      inPane: !!document.querySelector('#dBody #dLive'), inFooter: !!document.querySelector('.sfoot #dLive'),
      visible: n.checkVisibility ? n.checkVisibility({ checkVisibilityCSS: true }) : !n.hidden };
  })()`);
  const noLiveSession = { project: await liveLine('project'), session: await liveLine('session') };
  check('no live session: the live-state line is silent under BOTH lenses (silence, not a reassuring blank line)',
    noLiveSession.project.hidden === true && noLiveSession.session.hidden === true
      && noLiveSession.project.text === '' && noLiveSession.session.text === '',
    JSON.stringify(noLiveSession));
  await cdp.eval(`(() => { window.__station.state.effective = { overridden: ['model', 'effort'], effective: { model: 'opus', effort: 'high' } }; })()`);
  const withLive = { project: await liveLine('project'), session: await liveLine('session') };
  check('a live session under the SESSION lens: the line names the overridden fields, is visible, and renders in the PANE (round 4 moved it out of the footer)',
    withLive.session.hidden === false && withLive.session.visible === true
      && withLive.session.inPane === true && withLive.session.inFooter === false
      && /model, effort/.test(withLive.session.text) && /read back from the session/.test(withLive.session.text),
    JSON.stringify(withLive.session));
  check('the SAME live session under the PROJECT lens says nothing — the project defaults are not what the session is running',
    withLive.project.hidden === true && withLive.project.text === '', JSON.stringify(withLive.project));
  const liveSessionRows = await cdp.eval(`(async () => {
    const D = window.__station.drawer;
    D.close(); D.close();
    await D.open('settings', { scope: 'session' });
    await new Promise((r) => setTimeout(r, 600));
    const host = document.querySelector('#dBody .view.on');
    const rows = [...host.querySelectorAll('.set')].map((n) => (n.querySelector('.l')?.textContent || '').trim());
    return { rows, model: [...host.querySelectorAll('.set')].map((n) => n.textContent).find((t) => /Model/.test(t)) ?? null };
  })()`);
  check('and the live session does not remove a row: Model & spend still offers its own rows under the session lens while a session is live',
    liveSessionRows.rows.some((t) => /Model/.test(t)) && liveSessionRows.rows.some((t) => /Effort/.test(t)),
    JSON.stringify(liveSessionRows.rows.slice(0, 6)));
  await cdp.eval(`(() => { window.__station.state.effective = null; })()`);

  /* ══════════ 10. the rail's edge fades are SCROLL-AWARE ══════════ */
  section('10. the narrow rail\'s edge fades reflect the real scroll position');
  await closeIt();
  const EDGES = `(() => {
    const r = document.querySelector('#sRail');
    const cs = getComputedStyle(r);
    return { edge: r.dataset.edge ?? null, scrollLeft: Math.round(r.scrollLeft),
      max: Math.round(r.scrollWidth - r.clientWidth), overflows: r.scrollWidth > r.clientWidth + 1,
      fadeStart: cs.getPropertyValue('--fade-s').trim(), fadeEnd: cs.getPropertyValue('--fade-e').trim(),
      mask: (cs.maskImage && cs.maskImage !== 'none') ? 'set' : 'none' };
  })()`;
  const scrollRailTo = async (where) => cdp.eval(`(async () => {
    const r = document.querySelector('#sRail');
    const max = r.scrollWidth - r.clientWidth;
    r.scrollLeft = ${JSON.stringify(where)} === 'start' ? 0 : ${JSON.stringify(where)} === 'end' ? max : Math.round(max / 2);
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    await new Promise((res) => setTimeout(res, 120));
    return true;
  })()`);
  const edgeRuns = [];
  for (const [w, h] of [[800, 780], [500, 820]]) {
    await cdp.viewport(w, h);
    await sleep(250);
    await cdp.eval(`(async () => { const D = window.__station.drawer; D.close(); D.close(); await D.open('settings'); })()`);
    await sleep(400);
    for (const where of ['start', 'mid', 'end']) {
      await scrollRailTo(where);
      const e = await cdp.eval(EDGES);
      edgeRuns.push({ w, where, ...e });
    }
    await closeIt();
  }
  check('PRECONDITION: the strip genuinely overflows at both widths, so an edge fade has something to be about',
    edgeRuns.every((e) => e.overflows === true && e.max > 40),
    JSON.stringify(edgeRuns.map((e) => `${e.w}:${e.scrollLeft}/${e.max}`)));
  const atStart = edgeRuns.filter((e) => e.where === 'start');
  check('at scrollLeft 0 there is NO fade on the left — the defect: it faded the first category and promised content that was not there',
    atStart.every((e) => e.edge === 'end' && e.fadeStart === '0px' && e.fadeEnd === '24px'),
    JSON.stringify(atStart.map((e) => `${e.w}px → edge="${e.edge}" start=${e.fadeStart} end=${e.fadeEnd}`)));
  const atMid = edgeRuns.filter((e) => e.where === 'mid');
  check('mid-scroll BOTH ends fade, because there really is more in both directions',
    atMid.every((e) => e.edge === 'start end' && e.fadeStart === '24px' && e.fadeEnd === '24px'),
    JSON.stringify(atMid.map((e) => `${e.w}px → edge="${e.edge}" start=${e.fadeStart} end=${e.fadeEnd} (${e.scrollLeft}/${e.max})`)));
  const atEnd = edgeRuns.filter((e) => e.where === 'end');
  check('fully scrolled, only the left fades — the last category is not dimmed by a fade over nothing',
    atEnd.every((e) => e.edge === 'start' && e.fadeStart === '24px' && e.fadeEnd === '0px'),
    JSON.stringify(atEnd.map((e) => `${e.w}px → edge="${e.edge}" start=${e.fadeStart} end=${e.fadeEnd} (${e.scrollLeft}/${e.max})`)));
  check('the mask itself is still declared in every state (the fade is driven by its stop positions, not by turning the mask off)',
    edgeRuns.every((e) => e.mask === 'set'), JSON.stringify([...new Set(edgeRuns.map((e) => e.mask))]));
  await cdp.viewport(800, 780);
  await cdp.eval(`(async () => { const D = window.__station.drawer; D.close(); D.close(); await D.open('settings');
    document.querySelector('#sRail').scrollLeft = 0; })()`);
  await sleep(400);
  await shot('feat146b-rail-scroll-start.png', 3);
  await cdp.eval(`(() => { const r = document.querySelector('#sRail'); r.scrollLeft = Math.round((r.scrollWidth - r.clientWidth) / 2); })()`);
  await sleep(300);
  await shot('feat146b-rail-scroll-mid.png', 3);
  await closeIt();
  /* The desktop rail has nothing to scroll; the attribute must say so rather
     than keep whatever the narrow layout last wrote. */
  await cdp.viewport(1400, 1000);
  await sleep(250);
  await cdp.eval(`(async () => { const D = window.__station.drawer; D.close(); D.close(); await D.open('settings'); })()`);
  await sleep(400);
  const wide = await cdp.eval(EDGES);
  check('at desktop width the vertical rail reports no edges at all, so a stale "start end" from the narrow layout cannot outlive it',
    wide.edge === 'none' && wide.overflows === false, JSON.stringify(wide));
  await closeIt();

  /* ══════════ 11. MUST-FAIL ══════════ */
  section('11. must-FAIL: the completeness sweep against a SYNTHESIZED dropped card');
  /* The failure mode this phase actually has is a card that quietly stops being
     built. So the broken variant is exactly that: `integrationsGroup(...)` is
     removed from the Permissions builder — four flagged rows vanish and nothing
     else changes. Anchored to a constructed variant, never to a revision. */
  const realSrc = fs.readFileSync(path.join(ROOT, 'public', 'lib', 'drawer.js'), 'utf8');
  const marker = `return catWrap('caps', perms, integrationsGroup(p, sessionScope));`;
  check('PRECONDITION: the Permissions builder is where the mutation expects it',
    realSrc.includes(marker), marker);
  const brokenSrc = realSrc.replace(marker, `return catWrap('caps', perms);`);
  check('PRECONDITION: the synthesized variant really differs from the shipped one',
    brokenSrc !== realSrc, `${realSrc.length} → ${brokenSrc.length} bytes`);

  const serveDrawer = async (src) => {
    await disarmFetch();
    overrides.push({ test: (u) => u.includes('/lib/drawer.js'), mime: 'text/javascript', body: src });
    await armFetch([{ urlPattern: '*/lib/drawer.js', requestStage: 'Request' }]);
  };
  await serveDrawer(brokenSrc);
  await goto(containerId);
  const mutated = await cdp.eval(`(async () => (await (await fetch('/lib/drawer.js')).text()).includes("return catWrap('caps', perms);"))()`);
  check('the page is really running the synthesized variant', mutated === true, String(mutated));
  await seedAccounts();
  const brokenSweep = await cdp.eval(SWEEP);
  const brokenFlags = new Set(Object.values(brokenSweep).flatMap((r) => r.flags));
  const nowMissing = Object.keys(FLAG_INVENTORY).filter((f) => !brokenFlags.has(f));
  check('MUST-FAIL: with ONE card dropped from ONE category, the completeness sweep goes red and NAMES what vanished',
    nowMissing.length === 4 && nowMissing.every((f) => /browser\.enabled|tools\./.test(f)),
    `missing: ${nowMissing.join(' | ') || 'NOTHING — the sweep is vacuous'}`);

  /* ══════════ 12. MUST-FAIL for the SHAPE sweep ══════════
   * The shape sweep has the same failure mode one level down: a group that is
   * only built for SOME shapes quietly stops being built, and nothing notices
   * because no fixture has that shape. Two synthesized variants, each dropping
   * one shape-gated group, each graded by the same shape statement as above —
   * and each must NAME the rows that vanished. Anchored to constructed
   * variants, never to a revision. */
  section('12. must-FAIL: a dropped SHAPE-GATED group must name the rows that vanish');
  const gitMarker = `return catWrap(null, p.hostPath ? directoryBlock(p) : null, gitGroup(p), processesGroup(p));`;
  const svcMarker = `return catWrap('isoSection', runtime, access, servicesGroup(p, sessionScope));`;
  check('PRECONDITION: both shape-gated groups are where the mutations expect them',
    realSrc.includes(gitMarker) && realSrc.includes(svcMarker), 'workspacePane + isolationPane');

  const noGitSrc = realSrc.replace(gitMarker, `return catWrap(null, p.hostPath ? directoryBlock(p) : null, processesGroup(p));`);
  await serveDrawer(noGitSrc);
  await goto(gitUpId);
  await seedAccounts();
  const gitShape = SHAPES.find((s) => s.id.startsWith('git repo · remote'));
  const brokenGit = gradeShape(await cdp.eval(SHAPE_SWEEP('project')), { expect: gitShape.expect, gated: gitShape.gated ?? [] });
  check('MUST-FAIL: with gitGroup dropped, the git-repo shape goes red and NAMES the six controls only that shape could have shown',
    brokenGit.missing.length === 6 && brokenGit.missing.every((m) => m.startsWith('git.')),
    `missing: ${brokenGit.missing.join(' | ') || 'NOTHING — the shape sweep is vacuous'}`);

  const noSvcSrc = realSrc.replace(svcMarker, `return catWrap('isoSection', runtime, access);`);
  await serveDrawer(noSvcSrc);
  await goto(containerId);
  await seedAccounts();
  const contShape = SHAPES.find((s) => s.id.startsWith('container WITH'));
  const brokenSvc = gradeShape(await cdp.eval(SHAPE_SWEEP('project')), { expect: contShape.expect, gated: contShape.gated ?? [] });
  check('MUST-FAIL: with servicesGroup dropped, the container-with-a-service shape goes red and NAMES the services controls that vanished',
    brokenSvc.missing.length === 3 && brokenSvc.missing.every((m) => m.startsWith('svc.')),
    `missing: ${brokenSvc.missing.join(' | ') || 'NOTHING — the shape sweep is vacuous'}`);
  await disarmFetch();

  console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} passed, ${fail} failed`);
  if (fail) console.log(failures.map((f) => `  · ${f}`).join('\n'));
  console.log('\nscreenshots:');
  for (const s of shots) console.log(`  ${s}`);
}

try {
  await main();
} catch (err) {
  console.error(`\nHARNESS ERROR: ${err.stack || err.message}`);
  fail++;
} finally {
  cdp?.close();
  for (const p of procs) stopByPid(p);
  await sleep(500);
  process.exit(fail ? 1 : 0);
}
