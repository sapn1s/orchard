#!/usr/bin/env node
/*
 * FEAT-171 — Orchard on a phone: does the conversation get the screen?
 *
 *   node scripts/verify-feat-171-mobile.mjs [--label before|after] [--no-assert]
 *
 * Boots an ISOLATED scratch server (station-boot isolatedServerEnv: scratch data
 * dir + scratch transcript store, free port), seeds it with a realistic state —
 * a REAL transcript copied from the user's store (read-only copy, cwd rewritten
 * to the scratch project), a SYNTHETIC short back-and-forth chat (labelled
 * synthetic: "a couple of short messages", the user's own acceptance test), a
 * busy sidebar (16 sessions) and a copy of this repo's real ticket board so the
 * board rail is populated — then drives headless Chromium with touch emulation at
 * phone viewports and prints the acceptance numbers:
 *
 *   transcript % of viewport height, px above the transcript (top bar),
 *   sidebar / rail visible on first load, messages visible (full / partial),
 *   visible chat characters, horizontal overflow, and the open/close click path
 *   of each collapsed panel (incl. picking a session from the drawer).
 *
 * Desktop (1280x860 and 1024x768) is screenshotted for a before/after compare and
 * its geometry printed, so "desktop unchanged" is a measured claim.
 *
 * Screenshots land in docs/bugs/assets/FEAT-171-<label>-*.png.
 * Kills only the server it spawned, by pid. Exit 1 if any acceptance check fails
 * (unless --no-assert, used to record the baseline numbers).
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { chromium } from 'playwright';
import { isolatedServerEnv } from './lib/station-boot.mjs';

const args = process.argv.slice(2);
const LABEL = args.includes('--label') ? args[args.indexOf('--label') + 1] : 'run';
const ASSERT = !args.includes('--no-assert');
const ROOT = path.resolve(import.meta.dirname, '..');
// FEAT171_SERVE_ROOT: serve a different checkout (e.g. a copy holding the pre-change
// client) so desktop screenshots can be pixel-compared before vs after.
const SERVE_ROOT = process.env.FEAT171_SERVE_ROOT ? path.resolve(process.env.FEAT171_SERVE_ROOT) : ROOT;
const ASSETS = path.join(ROOT, 'docs', 'bugs', 'assets');
fs.mkdirSync(ASSETS, { recursive: true });

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f171-'));
const STORE = path.join(TMP, 'store'), PROJECTS = path.join(STORE, 'projects'), DATA = path.join(TMP, 'data'), WORK = path.join(TMP, 'work');
const enc = (s) => s.replace(/[^a-zA-Z0-9]/g, '-');
const DIRNAME = enc(WORK);
const DIR = path.join(PROJECTS, DIRNAME);
fs.mkdirSync(DIR, { recursive: true }); fs.mkdirSync(WORK, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = 0, bad = 0;
const check = (name, cond, obs) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${obs}`);
  cond ? ok++ : bad++;
};

// ── fixture: a real board (copied) so the rail has real content ─────────────
fs.cpSync(path.join(ROOT, 'docs', 'bugs'), path.join(WORK, 'docs', 'bugs'), {
  recursive: true, filter: (src) => !src.includes(`${path.sep}assets`),
});

// ── fixture: the REAL transcript (read-only copy) ───────────────────────────
// the user's real transcript store for THIS checkout (derived, never typed)
const REAL_SRC_DIR = path.join(os.homedir(), '.claude', 'projects', enc(ROOT));
const REAL_ID = process.env.FEAT171_REAL_ID ?? 'e5ca715a-2edd-42e8-9399-f9bb5d937366';
const realSrc = path.join(REAL_SRC_DIR, `${REAL_ID}.jsonl`);
let haveReal = false;
if (fs.existsSync(realSrc)) {
  const raw = fs.readFileSync(realSrc, 'utf8').split(ROOT).join(WORK);
  fs.writeFileSync(path.join(DIR, `${REAL_ID}.jsonl`), raw);
  haveReal = true;
}

// ── fixture: SYNTHETIC short chat — "send a couple of messages" ─────────────
const CHAT_ID = 'cccc0001-1111-4111-8111-000000000001';
const chat = [
  ['what does the stop hook check before a turn ends?', 'It reads the transcript tail and checks that the reply has a digest line first, then refuses the turn end if the format gate fails.'],
  ['ok and where is that configured?', 'In `settings.json` under `hooks.Stop` — the command points at `scripts/response-format-gate.mjs`.'],
  ['can I turn it off for one session?', 'Yes: pass `--no-gate` when you launch it, or toggle **Response gate** in Settings → Session. It only affects that session.'],
  ['thanks. is the dashboard up?', 'Yes — the service has been active since 09:12 and the health endpoint answers in about 4 ms.'],
  ['great, ship it', 'Done. Committed as `a1b2c3d` with the leak gate passing; nothing was pushed.'],
];
{
  const lines = []; let parent = null; let n = 0;
  const t0 = Date.now() - 30 * 60_000;
  for (const [q, a] of chat) {
    const uu = `cccc${String(++n).padStart(4, '0')}-2222-4222-8222-${String(n).padStart(12, '0')}`;
    lines.push({ parentUuid: parent, type: 'user', message: { role: 'user', content: q }, timestamp: new Date(t0 + n * 60_000).toISOString(), uuid: uu, cwd: WORK, sessionId: CHAT_ID, entrypoint: 'cli', userType: 'external', version: '2.1.158', gitBranch: 'main' });
    const au = `cccc${String(++n).padStart(4, '0')}-3333-4333-8333-${String(n).padStart(12, '0')}`;
    lines.push({ parentUuid: uu, type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: a }] }, timestamp: new Date(t0 + n * 60_000).toISOString(), uuid: au, cwd: WORK, sessionId: CHAT_ID, version: '2.1.158', gitBranch: 'main' });
    parent = au;
  }
  lines.push({ type: 'ai-title', aiTitle: 'Stop hook questions', sessionId: CHAT_ID });
  fs.writeFileSync(path.join(DIR, `${CHAT_ID}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

// ── fixture: busy sidebar (synthetic titles) ────────────────────────────────
const titles = ['Ship the usage-reset countdown', 'Investigate stalled dispatch broker', 'Refactor the session store reader',
  'Draft the public README rewrite', 'Hit a usage limit — parked', 'Profile the sidebar render', 'Old container migration notes',
  'Explore codex provider routing', 'Triage the fork-to-project bug', 'Write the onboarding checklist', 'Notes on the outbox pump',
  'Benchmark the transcript reader', 'Audit permission prompts', 'Tidy docs/prompts mirror'];
titles.forEach((title, i) => {
  const id = `bbbb${String(i).padStart(4, '0')}-1111-4111-8111-${String(i).padStart(12, '0')}`;
  const ts = new Date(Date.now() - (i + 2) * 3_600_000).toISOString();
  const lines = [
    { parentUuid: null, type: 'user', message: { role: 'user', content: title }, timestamp: ts, uuid: `${id.slice(0, 8)}-1111-4111-8111-111111111111`, cwd: WORK, sessionId: id, entrypoint: 'cli', userType: 'external', version: '2.1.158', gitBranch: 'main' },
    { parentUuid: `${id.slice(0, 8)}-1111-4111-8111-111111111111`, type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'a reply' }] }, timestamp: ts, uuid: `${id.slice(0, 8)}-2222-4222-8222-222222222222`, cwd: WORK, sessionId: id, version: '2.1.158', gitBranch: 'main' },
    { type: 'ai-title', aiTitle: title, sessionId: id },
  ];
  const f = path.join(DIR, `${id}.jsonl`);
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const t = new Date(Date.now() - (i + 2) * 3_600_000); fs.utimesSync(f, t, t);
});

// ── in-page measurement ─────────────────────────────────────────────────────
function measure() {
  const vw = innerWidth, vh = innerHeight;
  const scroll = document.querySelector('#scroll');
  const sr = scroll.getBoundingClientRect();
  const top = Math.max(0, sr.top), bot = Math.min(vh, sr.bottom);
  const onScreen = (el) => {
    if (!el) return 0;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return 0;
    const r = el.getBoundingClientRect();
    const w = Math.max(0, Math.min(vw, r.right) - Math.max(0, r.left));
    const h = Math.max(0, Math.min(vh, r.bottom) - Math.max(0, r.top));
    return w * h > 0 ? Math.round(w) : 0;
  };
  const pane = document.querySelector('#panes .pane.on');
  let full = 0, partial = 0;
  for (const m of pane ? pane.querySelectorAll(':scope > .you, :scope > .claude') : []) {
    const r = m.getBoundingClientRect();
    if (r.height === 0) continue;
    if (r.top >= top - 1 && r.bottom <= bot + 1) full++;
    else if (r.bottom > top && r.top < bot) partial++;
  }
  // visible non-whitespace characters of chat text inside the transcript viewport
  let chars = 0;
  if (pane) {
    const tw = document.createTreeWalker(pane, NodeFilter.SHOW_TEXT);
    const rg = document.createRange();
    const inside = (r) => r.width > 0 && r.bottom > top + 0.5 && r.top < bot - 0.5 && r.right > sr.left && r.left < sr.right;
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      const s = n.nodeValue; if (!s.trim()) continue;
      const pe = n.parentElement; if (!pe || pe.closest('.msg-ts')) continue;
      rg.selectNodeContents(n);
      const rects = [...rg.getClientRects()];
      if (!rects.length) continue;
      if (rects.every((r) => r.top >= top && r.bottom <= bot)) { chars += s.replace(/\s/g, '').length; continue; }
      if (!rects.some(inside)) continue;
      for (let i = 0; i < s.length; i++) {
        if (/\s/.test(s[i])) continue;
        rg.setStart(n, i); rg.setEnd(n, i + 1);
        const r = rg.getBoundingClientRect();
        if (inside(r)) chars++;
      }
    }
  }
  const crown = document.querySelector('.crown');
  const dock = document.querySelector('.dock');
  const prompt = document.querySelector('#prompt');
  return {
    vw, vh,
    transcriptPct: Math.round(((bot - top) / vh) * 1000) / 10,
    aboveTranscriptPx: Math.round(top),
    crownPx: Math.round(crown.getBoundingClientRect().height),
    dockPx: Math.round(dock.getBoundingClientRect().height),
    dockBottom: Math.round(dock.getBoundingClientRect().bottom),
    sideVisiblePx: onScreen(document.querySelector('.side')),
    railVisiblePx: onScreen(document.querySelector('.rail')),
    msgsFull: full, msgsPartial: partial, chars,
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    promptFontPx: parseFloat(getComputedStyle(prompt).fontSize),
  };
}

const PORT = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const BASE = `http://127.0.0.1:${PORT}`;
const sv = spawn(process.execPath, [path.join(SERVE_ROOT, 'src', 'server', 'index.ts')], {
  cwd: SERVE_ROOT,
  env: isolatedServerEnv({ PORT: String(PORT), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_CONFIG_DIR: STORE, CLAUDE_PROJECTS_DIR: PROJECTS }, { requireStore: true }),
  stdio: ['ignore', 'ignore', 'inherit'],
});
let browser = null;
const results = {};
try {
  for (let i = 0; i < 200; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* wait */ } await sleep(100); }
  const reg = await (await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: WORK, name: 'Orchard' }) })).json();
  const pid = reg.project.id;
  const hashFor = (sid) => `#/project/${encodeURIComponent(pid)}/session/${encodeURIComponent(sid)}?dir=${encodeURIComponent(DIRNAME)}`;
  console.log(`scratch server ${BASE} pid=${sv.pid}  real transcript: ${haveReal ? REAL_ID : 'ABSENT'}  label=${LABEL}`);

  try { browser = await chromium.launch(); } catch { browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome-stable', args: ['--headless=new'] }); }

  const openCtx = async ({ width, height, mobile, scheme = 'light' }) => {
    const ctx = await browser.newContext({
      viewport: { width, height }, colorScheme: scheme, deviceScaleFactor: mobile ? 3 : 1,
      hasTouch: !!mobile, isMobile: !!mobile,
    });
    await ctx.addInitScript((t) => { try { localStorage.setItem('cs.theme', t); } catch { /* */ } }, scheme);
    return ctx;
  };
  const loadSession = async (page, sid) => {
    await page.goto(BASE + '/' + hashFor(sid));
    await page.locator('#panes .pane.on > .claude').first().waitFor({ timeout: 20_000 });
    await sleep(900); // let layout, fonts and the at-bottom scroll settle
  };

  // ── phones (portrait) + landscape ──
  const phones = [
    { key: '390', width: 390, height: 844 },
    { key: '360', width: 360, height: 800 },
    { key: 'land', width: 844, height: 390 },
  ];
  for (const vp of phones) {
    for (const [sk, sid] of [['chat', CHAT_ID], ...(haveReal ? [['real', REAL_ID]] : [])]) {
      if (vp.key === 'land' && sk === 'real') continue;
      const ctx = await openCtx({ ...vp, mobile: true });
      const page = await ctx.newPage();
      await loadSession(page, sid);
      // must-FAIL probe (FEAT171_FORCE_CROWN_PX=120): synthesize a taller top bar to prove
      // the transcript-share checks actually bite. Never set in a normal run.
      if (process.env.FEAT171_FORCE_CROWN_PX) {
        await page.addStyleTag({ content: `.crown{height:${Number(process.env.FEAT171_FORCE_CROWN_PX)}px !important;min-height:${Number(process.env.FEAT171_FORCE_CROWN_PX)}px !important;}` });
        await sleep(400);
      }
      const m = await page.evaluate(measure);
      results[`${vp.key}/${sk}`] = m;
      console.log(`\n[${vp.key} ${vp.width}x${vp.height} ${sk}] ${JSON.stringify(m)}`);
      await page.screenshot({ path: path.join(ASSETS, `FEAT-171-${LABEL}-${vp.key}-${sk}-light.png`) });
      if (vp.key !== 'land') {
        // a title too long for the row ends in an ellipsis instead of being chopped
        const t = await page.evaluate(() => {
          const h = document.querySelector('#title'); const old = h.textContent;
          h.textContent = 'Fix session URL paths after the hash router change and the reload regression';
          const r = { trunc: h.scrollWidth > h.clientWidth, ellipsis: getComputedStyle(h).textOverflow, h: Math.round(h.getBoundingClientRect().height), crown: Math.round(document.querySelector('.crown').getBoundingClientRect().height) };
          h.textContent = old; return r;
        });
        check(`${vp.key} ${sk}: a long title stays one line and ends in an ellipsis`, t.trunc && t.ellipsis === 'ellipsis' && t.crown <= 48, JSON.stringify(t));
      }
      if (sk === 'chat' && vp.key !== 'land') {
        // dark theme too, same state
        await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
        await sleep(200);
        await page.screenshot({ path: path.join(ASSETS, `FEAT-171-${LABEL}-${vp.key}-${sk}-dark.png`) });
        await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
      }
      if (ASSERT || true) {
        const tag = `${vp.key} ${sk}`;
        const portrait = vp.key !== 'land';
        if (portrait) {
          check(`${tag}: transcript >= 75% of viewport height`, m.transcriptPct >= 75, `${m.transcriptPct}%`);
          check(`${tag}: everything above the transcript <= 48px`, m.aboveTranscriptPx <= 48, `${m.aboveTranscriptPx}px (crown ${m.crownPx}px)`);
        } else {
          // FEAT-171 r2 rescope: the user asked for the chat to take "most of the interface".
          // A landscape phone is ~360-390px tall, so a 47px crown + the one-row composer
          // leave ~70-73%; 70% is the floor (75% stays the portrait bar).
          check(`${tag}: transcript >= 70% of a landscape phone's height`, m.transcriptPct >= 70, `${m.transcriptPct}% (crown ${m.crownPx}px, above transcript ${m.aboveTranscriptPx}px)`);
        }
        check(`${tag}: sidebar collapsed on first load`, m.sideVisiblePx === 0, `side visible width ${m.sideVisiblePx}px`);
        check(`${tag}: board rail collapsed on first load`, m.railVisiblePx === 0, `rail visible width ${m.railVisiblePx}px`);
        check(`${tag}: no horizontal overflow`, m.scrollWidth <= m.vw && m.bodyScrollWidth <= m.vw, `scrollWidth ${m.scrollWidth} / body ${m.bodyScrollWidth} vs ${m.vw}`);
        check(`${tag}: composer fully on screen`, m.dockBottom <= m.vh, `dock bottom ${m.dockBottom} vs ${m.vh}`);
        check(`${tag}: composer text >= 16px (no iOS focus zoom)`, m.promptFontPx >= 16, `${m.promptFontPx}px`);
      }
      await ctx.close();
    }
  }

  // ── click paths at 390 (light) and 360 (dark) ──
  for (const [vp, scheme] of [[{ width: 390, height: 844 }, 'light'], [{ width: 360, height: 800 }, 'dark']]) {
    const ctx = await openCtx({ ...vp, mobile: true, scheme });
    const page = await ctx.newPage();
    await loadSession(page, CHAT_ID);
    const tag = `${vp.width} ${scheme}`;
    const nav = page.locator('#navBtn');
    const navVisible = await nav.isVisible().catch(() => false);
    check(`${tag}: a visible menu control opens the sidebar`, navVisible, `#navBtn visible=${navVisible}`);
    if (navVisible) {
      const nb = await nav.boundingBox();
      check(`${tag}: menu control is a >=44px touch target`, nb.width >= 44 && nb.height >= 44, `${Math.round(nb.width)}x${Math.round(nb.height)}`);
      await nav.tap();
      await sleep(450);
      const sideW = await page.evaluate(() => { const r = document.querySelector('.side').getBoundingClientRect(); return Math.round(Math.min(innerWidth, r.right) - Math.max(0, r.left)); });
      check(`${tag}: tapping the menu slides the full sidebar in`, sideW >= 240, `side on-screen width ${sideW}px`);
      const covered = await page.evaluate(() => ['#go', '#crownRail', '#prompt'].map((sel) => {
        const r = document.querySelector(sel).getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return `${sel}->${hit?.closest('.side') ? 'drawer' : (hit?.id || hit?.className)}`;
      }));
      check(`${tag}: with the drawer open, the scrim (or the drawer) covers every control behind it`, covered.every((c) => c.endsWith('navScrim') || c.endsWith('drawer')), covered.join(' '));
      await page.screenshot({ path: path.join(ASSETS, `FEAT-171-${LABEL}-${vp.width}-drawer-${scheme}.png`) });
      // real path: pick a different session from the drawer
      const proj = page.locator('#tree button.proj', { hasText: 'Orchard' }).first();
      try { await page.locator('#tree .kids button.row').first().waitFor({ timeout: 2_000 }); } catch { await proj.tap(); }
      const row = page.locator('#tree .kids button.row', { hasText: haveReal ? '' : 'usage-reset' }).filter({ hasNotText: 'Stop hook questions' }).first();
      await row.waitFor({ timeout: 10_000 });
      await row.tap();
      await sleep(900);
      const after = await page.evaluate(() => ({
        side: (() => { const r = document.querySelector('.side').getBoundingClientRect(); return Math.round(Math.max(0, Math.min(innerWidth, r.right) - Math.max(0, r.left))); })(),
        hash: location.hash,
      }));
      check(`${tag}: picking a session closes the drawer and opens that session`, after.side === 0 && !after.hash.includes(CHAT_ID) && after.hash.includes('/session/'), JSON.stringify(after));
      // open again, close via the scrim
      await nav.tap(); await sleep(450);
      await page.mouse.click(vp.width - 10, vp.height / 2); await sleep(450);
      const sideAfterScrim = await page.evaluate(() => { const r = document.querySelector('.side').getBoundingClientRect(); return Math.round(Math.max(0, Math.min(innerWidth, r.right) - Math.max(0, r.left))); });
      check(`${tag}: tapping outside the drawer closes it`, sideAfterScrim === 0, `side on-screen width ${sideAfterScrim}px`);
      // open again, close with Escape
      await nav.tap(); await sleep(450);
      await page.keyboard.press('Escape'); await sleep(450);
      const sideAfterEsc = await page.evaluate(() => { const r = document.querySelector('.side').getBoundingClientRect(); return Math.round(Math.max(0, Math.min(innerWidth, r.right) - Math.max(0, r.left))); });
      check(`${tag}: Escape closes the drawer`, sideAfterEsc === 0, `side on-screen width ${sideAfterEsc}px`);
    }
    // rail
    // the board control the user actually sees: the crown button on a phone,
    // the floating badge where there is none
    const badge = (await page.locator('#crownRail').isVisible().catch(() => false)) ? page.locator('#crownRail') : page.locator('#railBadge');
    const bVis = await badge.isVisible().catch(() => false);
    const bb = bVis ? await badge.boundingBox() : null;
    const dockTop = await page.evaluate(() => document.querySelector('.dock').getBoundingClientRect().top);
    check(`${tag}: board control visible and not covering the composer`, bVis && bb.y + bb.height <= dockTop, `visible=${bVis} box=${bb ? JSON.stringify({ y: Math.round(bb.y), h: Math.round(bb.height) }) : '-'} dockTop=${Math.round(dockTop)}`);
    if (bVis) {
      check(`${tag}: board control is a >=44px touch target`, bb.width >= 44 && bb.height >= 44, `${Math.round(bb.width)}x${Math.round(bb.height)}`);
      await badge.tap(); await sleep(450);
      const railW = await page.evaluate(() => { const r = document.querySelector('.rail').getBoundingClientRect(); return Math.round(Math.max(0, Math.min(innerWidth, r.right) - Math.max(0, r.left))); });
      check(`${tag}: tapping the board control slides the rail in`, railW >= 240, `rail on-screen width ${railW}px`);
      const dim = await page.evaluate(() => { const r = document.querySelector('#prompt').getBoundingClientRect(); const h = document.elementFromPoint(12, r.top + 5); return h?.id || h?.className; });
      check(`${tag}: with the rail open the page behind it is dimmed by the scrim`, dim === 'navScrim', `left-edge hit: ${dim}`);
      await page.screenshot({ path: path.join(ASSETS, `FEAT-171-${LABEL}-${vp.width}-rail-${scheme}.png`) });
      const rc = page.locator('#railClose');
      const rcVis = await rc.isVisible().catch(() => false);
      if (rcVis) {
        await rc.tap(); await sleep(450);
        const w = await page.evaluate(() => { const r = document.querySelector('.rail').getBoundingClientRect(); return getComputedStyle(document.querySelector('.rail')).visibility === 'hidden' ? 0 : Math.round(Math.max(0, Math.min(innerWidth, r.right) - Math.max(0, r.left))); });
        check(`${tag}: the rail's own close button closes it`, w === 0, `rail on-screen width ${w}px`);
        await badge.tap(); await sleep(450);
      } else check(`${tag}: the rail has a visible close button`, false, 'absent');
      await page.mouse.click(12, vp.height / 2); await sleep(450);
      const railW2 = await page.evaluate(() => { const r = document.querySelector('.rail').getBoundingClientRect(); return Math.round(Math.max(0, Math.min(innerWidth, r.right) - Math.max(0, r.left))); });
      check(`${tag}: tapping outside closes the rail`, railW2 === 0, `rail on-screen width ${railW2}px`);
    }
    // header details (status, model, board/guide/settings pills) still reachable
    const more = page.locator('#crownMore');
    const mVis = await more.isVisible().catch(() => false);
    check(`${tag}: a visible control reveals the session details strip`, mVis, `#crownMore visible=${mVis}`);
    if (mVis) {
      await more.tap(); await sleep(300);
      const sealVis = await page.locator('#seal').isVisible();
      const row1 = await page.evaluate(() => ['#navBtn', '#crownMore', '#crownRail'].map((s) => Math.round(document.querySelector(s).getBoundingClientRect().top)));
      check(`${tag}: with details open the crown's own controls stay on the first row`, row1.every((t) => t < 10), `tops ${row1.join(',')}`);
      const guideVis = await page.locator('#guideBtn').isVisible();
      const ov = await page.evaluate(() => document.documentElement.scrollWidth);
      check(`${tag}: details strip opens with its pills reachable, no overflow`, sealVis && guideVis && ov <= vp.width, `seal=${sealVis} guide=${guideVis} scrollWidth=${ov}`);
      await page.screenshot({ path: path.join(ASSETS, `FEAT-171-${LABEL}-${vp.width}-details-${scheme}.png`) });
      await more.tap(); await sleep(300);
      check(`${tag}: details strip closes again`, !(await page.locator('#seal').isVisible()), 'seal hidden after second tap');
    }
    // keyboard: Tab from the composer never lands inside the closed drawer / rail
    await page.locator('#prompt').focus();
    let strayFocus = null;
    for (let i = 0; i < 40 && !strayFocus; i++) {
      await page.keyboard.press('Tab');
      strayFocus = await page.evaluate(() => { const a = document.activeElement; return a && (a.closest('.side') || a.closest('.rail')) ? (a.id || a.className || a.tagName) : null; });
    }
    check(`${tag}: Tab never reaches into the closed drawer or rail`, !strayFocus, strayFocus ? `focus landed on ${strayFocus}` : '40 Tabs, none inside');
    // long-press a session row inside the open drawer -> its menu opens ABOVE the drawer
    if (navVisible) {
      await page.locator('#navBtn').tap(); await sleep(450);
      const row = page.locator('#tree .kids button.row').first();
      const rb = await row.boundingBox();
      await page.evaluate(({ x, y }) => {
        const t = document.elementFromPoint(x, y);
        t.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: x, clientY: y, isPrimary: true }));
      }, { x: rb.x + 40, y: rb.y + rb.height / 2 });
      await sleep(800);
      const menu = await page.evaluate(() => {
        const m = document.querySelector('#rowMenu');
        if (!m || !m.classList.contains('open')) return { open: false };
        const r = m.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(20, r.height / 2));
        return { open: true, onTop: !!hit && m.contains(hit), inView: r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight };
      });
      check(`${tag}: long-press on a drawer row opens its menu above the drawer, on screen`, menu.open && menu.onTop && menu.inView, JSON.stringify(menu));
      await page.evaluate(() => document.querySelector('#tree').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' })));
      await page.keyboard.press('Escape'); await sleep(200);
      await page.keyboard.press('Escape'); await sleep(450);
    }
    // a warning hidden in the details strip shows on the "more" button
    if (mVis) {
      const before = await page.locator('#crownMore').getAttribute('data-alert');
      await page.evaluate(() => {
        const u = document.querySelector('#usageBtn'); u.hidden = false; u.classList.add('danger');
      });
      await sleep(150);
      const after = await page.locator('#crownMore').getAttribute('data-alert');
      const lbl = await page.locator('#crownMore').getAttribute('aria-label');
      check(`${tag}: a usage danger hidden in the strip marks the "more" button (shape + label)`, before == null && after === '1' && /attention/.test(lbl), `before=${before} after=${after} label="${lbl}"`);
      if (scheme === 'light') await page.locator('.crown').screenshot({ path: path.join(ASSETS, `FEAT-171-${LABEL}-${vp.width}-crown-alert-${scheme}.png`) });
    }
    // the composer: type a message, the send button is a real touch target
    const go = await page.locator('#go').boundingBox();
    check(`${tag}: send button >= 40px`, go && go.width >= 40 && go.height >= 40, go ? `${Math.round(go.width)}x${Math.round(go.height)}` : 'absent');
    await ctx.close();
  }

  // ── a desktop window folded, then narrowed to a phone: the fold state must not
  //    reach the drawer, and widening again hands it back ──
  {
    const ctx = await openCtx({ width: 1280, height: 860, mobile: false });
    const page = await ctx.newPage();
    await loadSession(page, CHAT_ID);
    await page.locator('#fold').click(); await sleep(300);
    await page.setViewportSize({ width: 390, height: 844 }); await sleep(500);
    const closedW = await page.evaluate(() => { const r = document.querySelector('.side').getBoundingClientRect(); return getComputedStyle(document.querySelector('.side')).visibility === 'hidden' ? 0 : Math.round(Math.max(0, Math.min(innerWidth, r.right) - Math.max(0, r.left))); });
    const navOk = await page.locator('#navBtn').isVisible().catch(() => false);
    let drawer = null;
    if (navOk) {
      await page.locator('#navBtn').click(); await sleep(450);
      drawer = await page.evaluate(() => ({ w: Math.round(document.querySelector('.side').getBoundingClientRect().width), wordmark: getComputedStyle(document.querySelector('.brand .wordmark')).display !== 'none', rows: document.querySelectorAll('#tree button.proj').length }));
      await page.keyboard.press('Escape'); await sleep(450);
    }
    check('desktop folded -> phone width: drawer starts closed and opens in full (not the icon strip)', closedW === 0 && navOk && drawer && drawer.w >= 240 && drawer.wordmark, `closedW=${closedW} nav=${navOk} drawer=${JSON.stringify(drawer)}`);
    await page.setViewportSize({ width: 1280, height: 860 }); await sleep(500);
    const back = await page.evaluate(() => ({ collapsed: document.querySelector('#win').classList.contains('collapsed'), side: Math.round(document.querySelector('.side').getBoundingClientRect().width) }));
    check('phone -> desktop again: the desktop fold state is handed back', back.collapsed && back.side === 54, JSON.stringify(back));
    await ctx.close();
  }

  // ── desktop + tablet: geometry + screenshots for the before/after compare ──
  for (const vp of [{ width: 1280, height: 860 }, { width: 1024, height: 768 }, { width: 800, height: 1000 }]) {
    for (const scheme of ['light', 'dark']) {
      const ctx = await openCtx({ ...vp, mobile: false, scheme });
      const page = await ctx.newPage();
      await loadSession(page, CHAT_ID);
      const m = await page.evaluate(measure);
      const geo = await page.evaluate(() => ['.side', '.main', '.rail', '.crown', '#scroll', '.dock', '#seal', '#title']
        .map((s) => { const r = document.querySelector(s).getBoundingClientRect(); return `${s}=${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)}x${Math.round(r.height)}`; }).join(' '));
      results[`desk${vp.width}/${scheme}`] = { ...m, geo };
      console.log(`\n[desktop ${vp.width}x${vp.height} ${scheme}] ${geo}`);
      const nav = await page.locator('#navBtn').isVisible().catch(() => false);
      const more = await page.locator('#crownMore').isVisible().catch(() => false);
      const rclose = await page.locator('#railClose').isVisible().catch(() => false);
      check(`desktop ${vp.width} ${scheme}: no phone-only controls shown`, !nav && !more && !rclose, `navBtn=${nav} crownMore=${more} railClose=${rclose}`);
      await page.screenshot({ path: path.join(ASSETS, `FEAT-171-${LABEL}-desk${vp.width}-${scheme}.png`) });
      await ctx.close();
    }
  }
  // ── --live: the user's own acceptance test — send a couple of REAL messages
  //    from a phone viewport (the real claude CLI, scratch store) and count ──
  // KNOWN LIMIT (2026-10-07): in this scratch setup a UI send produced no turn at
  // all — identically on the pre-change client and at desktop width (FEAT171_LIVE_DESKTOP=1,
  // FEAT171_SERVE_ROOT=<pre-change copy>) — so it is an environment issue, not the
  // layout; the flag is kept so the run can be repeated where sessions do start.
  if (args.includes('--live')) {
    // its own direct-mode project: the main fixture project defaults to container
    // isolation, which would need Docker (never the host daemon from a scratch run)
    const LIVE = path.join(TMP, 'live');
    fs.mkdirSync(LIVE, { recursive: true });
    const live = await (await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: LIVE, name: 'Live', isolation: 'direct' }) })).json();
    // FEAT171_LIVE_DESKTOP=1 runs the same flow at desktop width (a control: is a
    // failure here phone-specific or not?)
    const LIVE_DESK = process.env.FEAT171_LIVE_DESKTOP === '1';
    const ctx = await openCtx(LIVE_DESK ? { width: 1280, height: 860, mobile: false } : { width: 390, height: 844, mobile: true });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/#/project/${encodeURIComponent(live.project.id)}`);
    const act = (loc) => (LIVE_DESK ? loc.click() : loc.tap());
    if (!LIVE_DESK) {
      await page.locator('#navBtn').waitFor({ timeout: 15_000 });
      await page.locator('#navBtn').tap(); await sleep(450);
    }
    // the project's own "+" (new session in THIS project) — the always-visible
    // affordance in the drawer; #newBtn would start a session in the scratch project
    const plusLoc = page.locator('#tree button.proj', { hasText: 'Live' }).first().locator('.plus');
    await page.locator('#tree button.proj', { hasText: 'Live' }).first().waitFor({ timeout: 15_000 });
    if (LIVE_DESK) await page.locator('#tree button.proj', { hasText: 'Live' }).first().hover();
    await act(plusLoc); await sleep(1200);
    const drawerGone = await page.evaluate(() => getComputedStyle(document.querySelector('.side')).visibility === 'hidden' || !document.querySelector('#win').classList.contains('nav-open'));
    check('live: starting a new session from the drawer puts the drawer away', drawerGone, `drawer closed=${drawerGone}`);
    const msgs = ['Reply in one short sentence: what is 2+2?', 'And in one short sentence, what is the capital of France?', 'One sentence: name a primary colour.'];
    let n = 0;
    for (const m of msgs) {
      await act(page.locator('#prompt'));
      await page.locator('#prompt').fill(m);
      if (process.env.FEAT171_LIVE_ENTER === '1') await page.keyboard.press('Enter'); else await act(page.locator('#go'));
      n++;
      try { await page.waitForFunction((k) => {
        const cs = document.querySelectorAll('#panes .pane.on > .claude');
        const st = document.querySelector('#sessStatus')?.dataset.state;
        return cs.length >= k && st === 'idle' && (cs[cs.length - 1].textContent || '').trim().length > 0;
      }, n, { timeout: 180_000 }); } catch (err) {
        await page.screenshot({ path: path.join(ASSETS, `FEAT-171-${LABEL}-390-live-stuck.png`) });
        console.log('LIVE STUCK', JSON.stringify(await page.evaluate(() => ({ status: document.querySelector('#sessStatus')?.dataset.state, fine: document.querySelector('#fine')?.textContent, pane: document.querySelector('#panes .pane.on')?.innerText.slice(-600), prompt: document.querySelector('#prompt')?.value, st: (() => { const t = window.__station?.state; return t ? { sid: t.stationSessionId, sdk: t.sdkSessionId, cur: t.current } : null; })(), say: [...document.querySelectorAll('.toast, .say, #say')].map((e) => e.textContent).join(' | ') }))));
        throw err;
      }
      await sleep(800);
    }
    const m = await page.evaluate(measure);
    results['390/live'] = m;
    console.log(`\n[390 live, ${msgs.length} real messages sent] ${JSON.stringify(m)}`);
    check('live: after sending real messages from the phone, every exchange is in view', m.msgsFull >= msgs.length * 2 - 1 && m.transcriptPct >= 75, `${m.msgsFull} full + ${m.msgsPartial} partial, ${m.chars} chars, transcript ${m.transcriptPct}%`);
    await page.screenshot({ path: path.join(ASSETS, `FEAT-171-${LABEL}-390-live-light.png`) });
    await ctx.close();
  }
  fs.writeFileSync(path.join(ASSETS, `FEAT-171-${LABEL}-metrics.json`), JSON.stringify(results, null, 2));
} finally {
  try { await browser?.close(); } catch { /* */ }
  try { sv.kill('SIGKILL'); } catch { /* */ }
  await sleep(200);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
}
console.log('\nsummary (transcript% | above-px | msgs full+partial | chars):');
for (const [k, m] of Object.entries(results)) if (!k.startsWith('desk')) console.log(`  ${k.padEnd(10)} ${String(m.transcriptPct).padStart(5)}% | ${String(m.aboveTranscriptPx).padStart(4)}px | ${m.msgsFull}+${m.msgsPartial} | ${m.chars}`);
console.log(`\n${ok}/${ok + bad} checks passed`);
process.exit(ASSERT && bad ? 1 : 0);
