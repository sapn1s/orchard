/**
 * FEAT-091 (renderer lane) — the browser render of layer-2 response blocks.
 *
 *   node scripts/verify-feat-091-renderer.mjs
 *
 * Drives a REAL browser (brave --headless=new over raw CDP — the rig
 * verify:bug-067 / verify:streaming-md use) against a REAL server, imports the
 * app's OWN renderer (public/lib/digest.js -> renderAssistantText, the same entry
 * the transcript calls) and renders fixtures through it, asserting on the produced
 * DOM. Then it captures the visual gate: collapsed / expanded / blocks-free /
 * notes-only / malformed-fence, at wide AND narrow widths, in BOTH themes, every
 * shot graded by scripts/lib/shot-luma.mjs.
 *
 * The renderer contract this proves (docs/bugs/FEAT-091):
 *   - orchard-answer  -> expanded prose, always visible.
 *   - orchard-notes   -> a <details> collapsed by default, expandable in place,
 *                        per-block state; a NOTES-ONLY turn still shows the fold.
 *   - fallback / unknown-block content -> ordinary prose, in document order,
 *                        never hidden, never dropped.
 *   - no blocks at all -> byte-for-byte the pre-FEAT-091 prose render.
 *   - unterminated fence / a fence inside a code block / malformed digest JSON /
 *     CRLF -> degrade to prose, content never swallowed.
 *   - [I] degradation is LOCAL (the amended contract): a well-formed block before
 *     OR after a malformed region keeps its rendering; only a wholly unparseable
 *     message renders wholly as prose; nothing is ever folded away that the
 *     author did not put in `orchard-notes`.
 *
 * [P] then attacks the highest-value divergence: the renderer and the Stop hook
 * share ONE grammar module, so a corpus of adversarial messages is pushed through
 * BOTH — the browser import and the hook's own import specifier, plus the REAL
 * hook as a child process — and block classification and per-region content
 * attribution must be identical. Module identity is proven at RUNTIME (resolved
 * realpath + sha256 of the served bytes + exactly one tracked module), because a
 * copy that started identical and drifted is the failure this exists to catch.
 * [K] proves the fold is really keyboard- and screen-reader-reachable with real
 * key events and a real accessibility-tree read, never by inspecting markup.
 *
 * [R] closes the residual the eleventh independent pass named: the RANDOMISED
 * corpus that `verify:feat-091-commonmark-diff` generates was graded in node
 * only, never rendered, so the widest part of the suite explored nowhere near
 * the reader. A stratified sample of that exact space — same generator, imported
 * from the same module — is now rendered here and graded against the CommonMark
 * reference in both directions (hiding AND fold-lost), with the served parser
 * bytes swapped for pinned prior generations to prove the leg is not decoration.
 * [T] adds the dimension no pass has touched: a closed fold must be genuinely
 * closed in BOTH themes, asked in PIXELS, because a CSS regression that reveals
 * a fold in one palette is invisible to structure and to the AX tree alike.
 *
 * Theme is set via CDP prefers-color-scheme emulation (never localStorage); the
 * data-theme attribute is cleared so the media-query tokens drive the palette.
 *
 * Process hygiene: OS-assigned free port (never 4317). Children killed by PID
 * only, never pkill. Throwaway data dir + browser profile, removed on exit.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { shotLedger, md5, meanLuma } from './lib/shot-luma.mjs';

/*
 * BUG-118 (round 2): the Stop hook grades only the session its ORCHARD_SESSION
 * marker NAMES — a presence flag was inherited by nested hand-started sessions.
 * These suites test the GRADER, so each run declares itself the owner of the
 * payload it sends, injecting a session id when a fixture omits one (a real Stop
 * payload always carries one). The launcher gate is BUG-118's own suite.
 */
const SUITE_SESSION_ID = '0b118000-0000-4000-8000-000000000118';
const ownPayload = (o) => (o && typeof o === 'object' && typeof o.session_id !== 'string')
  ? { ...o, session_id: SUITE_SESSION_ID } : o;
const ownMarker = (o) => (o && typeof o?.session_id === 'string') ? o.session_id : SUITE_SESSION_ID;
/** Same, for suites that feed RAW stdin (including deliberate garbage). */
function ownRaw(input) {
  try {
    const o = JSON.parse(input);
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      const p = ownPayload(o);
      return { input: JSON.stringify(p), marker: ownMarker(p) };
    }
  } catch { /* garbage stays garbage: the hook must fail open on it */ }
  return { input, marker: SUITE_SESSION_ID };
}

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const PORT = Number(process.env.VERIFY_F091R_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f091r-data-'));
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f091r-store-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f091r-chrome-'));
const SHOTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f091r-shots-'));
const TX = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f091r-tx-'));
const BRAVE = process.env.VERIFY_F091R_BROWSER ?? 'brave';
const KEEP_SHOTS = process.env.VERIFY_F091R_KEEP === '1';

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  ok ? pass++ : (fail++, failures.push(name));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  async waitFor(label, expr, timeoutMs = 30_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { if (await this.eval(expr)) return true; } catch { /* mid-navigation */ }
      await sleep(150);
    }
    console.log(`        (timed out waiting for ${label} after ${timeoutMs}ms)`);
    return false;
  }
  close() { try { this.ws.close(); } catch { /* already gone */ } }
}

/* ------------------------------------------------------------- processes */
let server = null, browser = null;
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

/* ------------------------------------------------------------- fixtures
 * Realistic, not minimal (docs/CONVENTIONS.md): the FULL reply is a busy turn —
 * a digest, an answer with a question, a notes block carrying an inner ```code```
 * fence, a second answer, and a loose run of verification output that the author
 * failed to categorise (the fallback the design must never drop). B4 = 4 backticks
 * (the recommended opener, so inner triple-backtick code survives). */
const B3 = '```';
const B4 = '````';

const FULL = [
  `${B3}orchard-digest`,
  '{ "items": [',
  '  { "text": "Ship the parser move behind the shared grammar.", "kind": "decision", "importance": "high", "ref": "FEAT-091" },',
  '  { "text": "verify:feat-091 is green at 97/0.", "kind": "done", "importance": "med" }',
  '] }',
  B3,
  `${B4}orchard-answer`,
  'The renderer is wired and the grammar is now shared with the hook.',
  '',
  'One decision for you: should notes default collapsed **globally**, or per block? I went per-block — do you want to override that?',
  B4,
  `${B4}orchard-notes`,
  'Moved the parser and repointed the import:',
  '',
  `${B3}`,
  '$ git mv scripts/lib/response-blocks.mjs public/lib/response-blocks.js',
  'moved',
  `${B3}`,
  '',
  'Then re-ran the suite to confirm nothing drifted.',
  B4,
  `${B4}orchard-answer`,
  'Findings: the CRLF path and the fence-in-code path both hold.',
  B4,
  'PASS  the copied grammar is byte-identical to the source',
  'TOTAL: 97 passed, 0 failed, exit 0',
  'I left the loose run above uncategorised on purpose — it must still render.',
].join('\n');

const BLOCKS_FREE = 'Done — the three checks pass now and the tree is clean. Want me to commit?';

const NOTES_ONLY = [
  `${B4}orchard-notes`,
  'Spent this turn purely reading: walked the parser, the hook import, and the',
  'digest renderer. Nothing to decide yet — next turn I start the wiring.',
  B4,
].join('\n');

// Unterminated orchard-answer fence -> everything from the opener is fallback prose.
const MALFORMED_FENCE = [
  'Here is the state before the unterminated block:',
  '',
  `${B4}orchard-answer`,
  'This answer fence is never closed, so per the contract the opener line and all',
  'of this text must degrade to ordinary prose — visible, not an error, not dropped.',
  'The important ask below MUST survive: do you approve the parser move?',
].join('\n');

// A documented ```orchard-answer example INSIDE a 4-backtick code block stays inert.
const FENCE_IN_CODE = [
  'To document the format, here is an example block:',
  '',
  B4,
  `${B3}orchard-answer`,
  'This is illustration text, not a real block — it must render as code, inert.',
  B3,
  B4,
  'That example above must NOT become a real answer block.',
].join('\n');

// CRLF everywhere: digest + answer + notes must still classify (no trailing \r).
const CRLF = [
  `${B3}orchard-digest`,
  '{ "items": [ { "text": "CRLF transcript still classifies.", "kind": "fyi", "importance": "med" } ] }',
  B3,
  `${B4}orchard-answer`,
  'This whole message uses CRLF line endings.',
  B4,
  `${B4}orchard-notes`,
  'And the notes still collapse rather than misclassifying as an unknown block.',
  B4,
].join('\r\n');

// Malformed leading digest JSON + a valid-looking answer after -> FEAT-083 says
// render the WHOLE message as prose (drop the digest), content never lost.
const MALFORMED_DIGEST = [
  `${B3}orchard-digest`,
  '{ items: [ this is not valid json ] ',
  B3,
  `${B4}orchard-answer`,
  'Even this answer renders as plain prose because the leading digest is malformed.',
  B4,
].join('\n');

/* ── the CORRECTED malformed contract (FEAT-091, spec amendment) ─────────────
 * The original wording ("malformed input degrades to plain prose — the WHOLE
 * message must remain readable") was applied literally by an independent pass and
 * reported BROKEN because a valid block before a broken fence kept its rendering.
 * The wording was wrong, not the render: demoting a good block because something
 * LATER is malformed loses structure and protects nothing. The contract is now
 * (1) nothing lost or hidden, (2) document order preserved, (3) degradation is
 * LOCAL, (4) only a wholly unparseable message renders wholly as prose. These
 * three fixtures pin exactly that, on rendered TEXT. */

// A well-formed answer, then an UNTERMINATED notes fence. The answer keeps its
// block; the unterminated region degrades to visible prose. Nothing is lost.
const VALID_THEN_UNTERM = [
  `${B4}orchard-answer`,
  'VISIBLE-FIRST — the decision you must make is in this block.',
  B4,
  `${B4}orchard-notes`,
  'VISIBLE-SECOND — this fence is never closed, so it degrades to prose.',
].join('\n');

// An UNTERMINATED notes fence followed by a well-formed answer. The plain fence
// rule used to make the trailing ```` close the NOTES block, swallowing the
// answer into the collapsed fold — the reader's decision hidden, silently, with
// no malformed flag at all. The grammar now treats this as a MISSING CLOSE.
const UNTERM_THEN_VALID = [
  `${B4}orchard-notes`,
  'NARRATION-ONE — I read the parser and repointed the import.',
  `${B4}orchard-answer`,
  'DECISION-TWO — do you want the notes fold open by default? This must be VISIBLE.',
  B4,
].join('\n');

// Cannot be parsed at all: no fences, no structure. Rule 4 — one prose render.
const UNPARSEABLE = [
  'NOPARSE-ONE — there is no fence anywhere in this message.',
  '',
  'NOPARSE-TWO — so there is nothing to degrade; it is simply prose.',
].join('\n');

/* ── ROUND 12: the SEMANTIC vocabulary, as a reader sees it ──────────────────
 * A realistic busy turn using all six categories plus the declared fallback. The
 * claims this fixture exists to prove are reader-facing, not structural: every
 * visible category is CAPTIONED (so the ask is findable without reading the
 * finding), only the SUPPORTING RECORD folds, and the uncategorized block is shown
 * WITH the author's own label rather than hidden or painted as an error.
 *
 * ROUND 13 (FEAT-093): the finding block carries TWO sentences on purpose. A
 * folded finding shows its FIRST sentence as a preview, so a single-sentence
 * fixture could not tell "the preview works" apart from "the fold leaked" — the
 * one token would be visible either way. With two, the claim is exact: the first
 * sentence is readable without interacting, the second is not. */
const SEMANTIC = [
  `${B4}orchard-finding`,
  'SEM-FINDING — the board classifies any status containing the word done as finished.',
  'SEM-FINDING-BODY — and the two tickets it moved were both still in review.',
  B4,
  `${B4}orchard-outcome`,
  'SEM-OUTCOME — the word match is gone; two tickets moved back to Open.',
  B4,
  `${B4}orchard-ask`,
  'SEM-ASK — approve the board redesign? My recommendation is yes, with collapsing.',
  B4,
  `${B4}orchard-judgment`,
  'SEM-JUDGMENT — I did not send this for an independent pass; the budget is better spent on ARCH-003.',
  B4,
  `${B4}orchard-status`,
  'SEM-STATUS — two lanes running; nothing needs you.',
  B4,
  `${B4}orchard-narration`,
  'SEM-NARRATION — I read the parser, then wired the hook, then re-ran the suite.',
  B4,
  `${B4}orchard-uncategorized a copy-paste prompt for you to run`,
  'SEM-UNCAT — You are migrating a project to its new permanent home.',
  B4,
].join('\n');

/* MIGRATION, rendered: an archived message written in the retired vocabulary.
 * It must render exactly as it always did — visible prose with NO caption, and a
 * fold whose summary still says Notes. */
const LEGACY_MIX = [
  `${B4}orchard-answer`,
  'LEG-ANSWER — an archived reader-facing block from before the rename.',
  B4,
  `${B4}orchard-notes`,
  'LEG-NOTES — archived narration, still folded.',
  B4,
].join('\n');

const FIXTURES = {
  FULL, BLOCKS_FREE, NOTES_ONLY, MALFORMED_FENCE, FENCE_IN_CODE, CRLF, MALFORMED_DIGEST,
  VALID_THEN_UNTERM, UNTERM_THEN_VALID, UNPARSEABLE, SEMANTIC, LEGACY_MIX,
};

/* ═══════════════ the DIVERGENCE corpus (renderer ⇄ Stop hook) ════════════════
 * The SAME grammar module backs the browser render and the Stop hook that counts
 * uncategorized output. If they ever disagree, the display and the metrics tell
 * different stories — and the metrics are the mechanism deciding whether a new
 * block name is justified. Every message below carries unique `TKnn` tokens, one
 * per authored region, so "content attribution" can be asserted exactly: which
 * region did each piece of text end up in, on each path.
 *
 * Contents (everything the independent pass listed as untested):
 * a malformed table inside notes, fence markers inside a block's own content,
 * unknown and empty block names, ordering of uncategorized prose, six interleaved
 * blocks, very large content, Unicode whitespace in a block name, CRLF. */
const B5 = '`````';
const CORPUS = [
  { tag: 'notes-malformed-table', text: [
    `${B4}orchard-notes`,
    'TK01 ran the sweep; the table below is deliberately broken:',
    '| col a | col b',
    '|---|',
    '| TK02 | only one cell',
    'trailing narration TK03',
    B4,
  ].join('\n') },

  { tag: 'fence-markers-inside-content', text: [
    `${B5}orchard-answer`,
    'TK04 the answer itself talks about fences:',
    B4,
    `${B3}orchard-notes`,
    'TK05 this is an illustration, not a block',
    B3,
    B4,
    'TK06 and the answer continues after it.',
    B5,
  ].join('\n') },

  { tag: 'unknown-and-empty-names', text: [
    'TK07 lead-in prose.',
    `${B4}orchard-futureblock`,
    'TK08 a name that ships ahead of its spec.',
    B4,
    `${B4}orchard-`,
    'TK09 an empty reserved name.',
    B4,
    `${B4}`,
    'TK10 a fence with no info string at all.',
    B4,
  ].join('\n') },

  { tag: 'ordering-of-uncategorized-prose', text: [
    'TK11 before any block.',
    `${B4}orchard-answer`,
    'TK12 the decision.',
    B4,
    'TK13 between the blocks.',
    `${B4}orchard-notes`,
    'TK14 the narration.',
    B4,
    'TK15 after every block.',
  ].join('\n') },

  { tag: 'six-interleaved-blocks', text: [
    `${B4}orchard-answer`, 'TK16 first answer.', B4,
    `${B4}orchard-notes`, 'TK17 first notes.', B4,
    'TK18 loose run one.',
    `${B4}orchard-answer`, 'TK19 second answer.', B4,
    `${B4}orchard-notes`, 'TK20 second notes.', B4,
    'TK21 loose run two.',
    `${B4}orchard-answer`, 'TK22 third answer.', B4,
    `${B4}orchard-notes`, 'TK23 third notes.', B4,
  ].join('\n') },

  { tag: 'very-large-content', text: [
    `${B4}orchard-answer`,
    'TK24 ' + 'the decision text repeats. '.repeat(1200),
    B4,
    'TK25 ' + 'loose uncategorised bulk. '.repeat(1600),
    `${B4}orchard-notes`,
    'TK26 ' + 'narration bulk. '.repeat(1200),
    B4,
  ].join('\n') },

  { tag: 'unicode-whitespace-in-name', text: [
    `${B4}orchard-answer\u00a0`,          // NBSP after the name
    'TK27 trailing no-break space after the name.',
    B4,
    `${B4}orchard\u2007-notes`,           // figure space INSIDE the name
    'TK28 a figure space INSIDE the name.',
    B4,
    `${B4}orchard-notes\u200b`,           // zero-width space after the name
    'TK29 a zero-width space after the name.',
    B4,
  ].join('\n') },

  { tag: 'crlf-line-endings', text: [
    `${B4}orchard-answer`,
    'TK30 CRLF answer.',
    B4,
    'TK31 CRLF loose prose.',
    `${B4}orchard-notes`,
    'TK32 CRLF narration.',
    B4,
  ].join('\r\n') },

  { tag: 'valid-then-unterminated', text: [
    `${B4}orchard-answer`, 'TK33 good block.', B4,
    `${B4}orchard-notes`, 'TK34 never closed.',
  ].join('\n') },

  { tag: 'unterminated-notes-swallowing-answer', text: [
    `${B4}orchard-notes`, 'TK35 narration.',
    `${B4}orchard-answer`, 'TK36 the decision that must not be folded away.', B4,
  ].join('\n') },

  { tag: 'visible-block-swallowing-a-notes-opener', text: [
    `${B4}orchard-answer`, 'TK37 answer.',
    `${B4}orchard-notes`, 'TK38 swallowed but still visible.', B4,
  ].join('\n') },

  { tag: 'no-structure-at-all', text: 'TK39 plain reply, no fences.\n\nTK40 second paragraph.' },

  // Rule 4: a malformed LEADING digest renders the WHOLE message as prose
  // (FEAT-083). The PARSE still sees blocks — this is a render decision, not a
  // parse disagreement — so the DOM attribution is asserted as whole-prose.
  { tag: 'malformed-leading-digest', wholeProse: true, text: [
    `${B3}orchard-digest`, '{ items: not json TK41 }', B3,
    `${B4}orchard-answer`, 'TK42 still shown, as prose.', B4,
  ].join('\n') },
];

async function main() {
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  browser = spawn(BRAVE, [
    '--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', '--force-device-scale-factor=1', '--hide-scrollbars',
    '--window-size=1400,1000', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 60 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  if (!devPort) throw new Error('browser never wrote DevToolsActivePort');
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const pageT = targets.find((t) => t.type === 'page');
  const cdp = await Cdp.connect(pageT.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: `${BASE}/` });
  const booted = await cdp.waitFor('stylesheet + renderer', `(() => {
    try {
      const styled = getComputedStyle(document.body).fontFamily.length > 0;
      return styled && !!document.querySelector('link[rel="stylesheet"]');
    } catch { return false; }
  })()`, 30_000);
  if (!booted) throw new Error('page never became ready');
  // Import the renderer once and stash it on window for reuse.
  const imported = await cdp.eval(`(async () => {
    const m = await import('/lib/digest.js');
    window.__f091 = m;
    return typeof m.renderAssistantText === 'function';
  })()`);
  if (!imported) throw new Error('renderAssistantText not importable from /lib/digest.js');

  // Expose the fixtures in the page.
  await cdp.eval(`window.__FIX = ${JSON.stringify(FIXTURES)}; true`);

  /* Render one fixture into a fresh detached container and return a probe. The
     container is real DOM under the app stylesheet, so .digest/.prose/.orchard-*
     are all styled exactly as in the transcript. */
  const RENDER = (key, { open = false } = {}) => `(() => {
    const host = document.getElementById('f091-probe') || (() => {
      const h = document.createElement('div'); h.id = 'f091-probe'; document.body.appendChild(h); return h;
    })();
    host.replaceChildren();
    const node = window.__f091.renderAssistantText(window.__FIX[${JSON.stringify(key)}], { enabled: true, projectId: null });
    host.appendChild(node);
    if (${open ? 'true' : 'false'}) host.querySelectorAll('details.orchard-notes').forEach((d) => { d.open = true; });
    const q = (s) => host.querySelector(s);
    const notes = [...host.querySelectorAll('details.orchard-notes')];
    // What the reader can read WITHOUT interacting: the body of a closed
    // <details> is removed from a clone. This is the "hidden" half of the
    // contract — textContent alone cannot tell collapsed from expanded.
    const clone = host.cloneNode(true);
    clone.querySelectorAll('details.orchard-notes').forEach((d) => {
      if (!d.open) d.querySelector('.orchard-notes-body')?.remove();
    });
    return {
      text: host.textContent,
      visibleText: clone.textContent,
      hasDigest: !!q('.digest'),
      answerCount: host.querySelectorAll('.orchard-answer').length,
      answerText: [...host.querySelectorAll('.orchard-answer')].map((a) => a.textContent.trim()),
      notesCount: notes.length,
      notesOpen: notes.map((d) => d.open),
      notesSummary: notes.map((d) => (d.querySelector('summary')?.textContent ?? '').replace(/\\s+/g, ' ').trim()),
      notesBodyText: notes.map((d) => d.querySelector('.orchard-notes-body')?.textContent ?? ''),
      // ROUND 13 — the preview line, per fold, so "which folds have one" is a fact
      // read off the DOM rather than inferred from the summary's concatenated text.
      notesPrev: notes.map((d) => d.querySelector('.orchard-notes-prev')?.textContent ?? null),
      proseCount: host.querySelectorAll('.prose').length,
      // ROUND 12 — the category surface, read from the DOM the reader gets.
      caps: [...host.querySelectorAll('.ob-cap-lbl')].map((n) => n.textContent.trim()),
      capNotes: [...host.querySelectorAll('.ob-cap-note')].map((n) => n.textContent.trim()),
      cats: [...host.querySelectorAll('[class*=\"ob-\"]')]
        .map((n) => [...n.classList].find((c) => c.startsWith('ob-') && !c.startsWith('ob-cap')))
        .filter(Boolean),
      // The DOM order of the primary structural children, to prove document order.
      order: [...host.querySelectorAll('.digest, .orchard-answer, details.orchard-notes, #f091-probe > .prose, .msg-layer2 > .prose, .msg-with-digest > .prose')]
        .map((n) => n.classList.contains('digest') ? 'digest'
          : n.classList.contains('orchard-answer') ? 'answer'
          : n.tagName === 'DETAILS' ? 'notes' : 'prose'),
    };
  })()`;

  console.log('\n=== [A] FULL reply: digest + answer + notes(+code) + answer + fallback ===');
  const full = await cdp.eval(RENDER('FULL'));
  check('digest lifted to the top', full.hasDigest, { hasDigest: full.hasDigest });
  check('both orchard-answer blocks render expanded (2)', full.answerCount === 2, { answerCount: full.answerCount });
  check('the answer question survives verbatim', full.answerText.join(' ').includes('per block'), full.answerText);
  check('exactly one collapsed notes block', full.notesCount === 1, { notesCount: full.notesCount });
  check('notes is COLLAPSED by default (details not open)', full.notesOpen.every((o) => o === false), full.notesOpen);
  check('notes summary reads as a labelled control, not an empty line', /notes/i.test(full.notesSummary.join(' ')), full.notesSummary);
  check('notes CONTENT is in the DOM (present, just folded — nothing dropped)',
    full.notesBodyText.join(' ').includes('re-ran the suite'), full.notesBodyText.map((t) => t.slice(0, 40)));
  check('notes inner ```code``` survived the 4-backtick block', full.notesBodyText.join(' ').includes('git mv scripts/lib/response-blocks'), 'inner code present');
  check('uncategorised fallback run still renders (never dropped)',
    full.text.includes('TOTAL: 97 passed') && full.text.includes('left the loose run above uncategorised'), 'fallback present');
  check('document order is digest → answer → notes → answer → fallback',
    JSON.stringify(full.order) === JSON.stringify(['digest', 'answer', 'notes', 'answer', 'prose']), full.order);

  console.log('\n=== [B] expandability: opening the notes reveals its prose in place ===');
  const fullOpen = await cdp.eval(RENDER('FULL', { open: true }));
  check('opened notes is now [open] and shows its body', fullOpen.notesOpen.every((o) => o === true), fullOpen.notesOpen);
  check('opened notes body still holds the full narration', fullOpen.notesBodyText.join(' ').includes('re-ran the suite'), 'present when open');

  console.log('\n=== [C] blocks-free short reply renders byte-for-byte as plain prose ===');
  const free = await cdp.eval(RENDER('BLOCKS_FREE'));
  check('no digest, no answer, no notes — zero ceremony', !free.hasDigest && free.answerCount === 0 && free.notesCount === 0,
    { hasDigest: free.hasDigest, answerCount: free.answerCount, notesCount: free.notesCount });
  check('exactly one .prose node (the whole message)', free.proseCount === 1, { proseCount: free.proseCount });
  check('the message text is intact', free.text.includes('the three checks pass now'), free.text.slice(0, 60));

  console.log('\n=== [D] notes-only turn still shows a turn happened ===');
  const only = await cdp.eval(RENDER('NOTES_ONLY'));
  check('notes-only renders a single collapsed notes fold', only.notesCount === 1 && only.notesOpen[0] === false, { notesCount: only.notesCount, open: only.notesOpen });
  check('notes-only is NOT an empty message (summary label present)', /notes/i.test(only.notesSummary.join(' ')), only.notesSummary);
  check('notes-only body content is preserved behind the fold', only.notesBodyText.join(' ').includes('walked the parser'), 'present');
  check('notes-only did not vanish (has visible text)', only.text.trim().length > 0, only.text.slice(0, 40));

  console.log('\n=== [E] unterminated fence degrades to prose, ask survives ===');
  const mal = await cdp.eval(RENDER('MALFORMED_FENCE'));
  check('no orchard-answer element materialised from the unterminated fence', mal.answerCount === 0, { answerCount: mal.answerCount });
  check('no notes fold either', mal.notesCount === 0, { notesCount: mal.notesCount });
  check('the whole thing rendered as prose', mal.proseCount >= 1, { proseCount: mal.proseCount });
  check('the buried ask was NOT swallowed', mal.text.includes('do you approve the parser move'), 'ask present');

  console.log('\n=== [F] a fence inside a code block stays inert ===');
  const inert = await cdp.eval(RENDER('FENCE_IN_CODE'));
  check('the documented ```orchard-answer example did NOT become a real block', inert.answerCount === 0 && inert.notesCount === 0,
    { answerCount: inert.answerCount, notesCount: inert.notesCount });
  check('the illustration text is still shown', inert.text.includes('illustration text, not a real block'), 'present');

  console.log('\n=== [G] CRLF transcript classifies correctly (no trailing \\r) ===');
  const crlf = await cdp.eval(RENDER('CRLF'));
  check('CRLF: digest still lifted', crlf.hasDigest, { hasDigest: crlf.hasDigest });
  check('CRLF: answer classified (not an unknown block)', crlf.answerCount === 1, { answerCount: crlf.answerCount });
  check('CRLF: notes collapsed (not misclassified)', crlf.notesCount === 1 && crlf.notesOpen[0] === false, { notesCount: crlf.notesCount });

  console.log('\n=== [H] malformed leading digest JSON -> whole message as prose (FEAT-083) ===');
  const md = await cdp.eval(RENDER('MALFORMED_DIGEST'));
  check('malformed digest is NOT painted as a structured digest', !md.hasDigest, { hasDigest: md.hasDigest });
  check('the answer below it is NOT specially rendered (whole message is prose)', md.answerCount === 0, { answerCount: md.answerCount });
  check('nothing dropped: the answer text is still present as prose', md.text.includes('renders as plain prose because'), 'present');

  /* ------------------------------- [I] the CORRECTED malformed contract ---- */
  console.log('\n=== [I] malformed degrades LOCALLY: good blocks keep their rendering ===');
  const vtu = await cdp.eval(RENDER('VALID_THEN_UNTERM'));
  check('valid answer BEFORE an unterminated fence keeps its block rendering', vtu.answerCount === 1, { answerCount: vtu.answerCount });
  check('the answer block holds VISIBLE-FIRST', vtu.answerText.join(' ').includes('VISIBLE-FIRST'), vtu.answerText);
  check('the unterminated region rendered as prose, not as a notes fold', vtu.notesCount === 0, { notesCount: vtu.notesCount });
  check('BOTH strings are readable with no interaction (nothing lost, nothing folded)',
    vtu.visibleText.includes('VISIBLE-FIRST') && vtu.visibleText.includes('VISIBLE-SECOND'),
    { first: vtu.visibleText.includes('VISIBLE-FIRST'), second: vtu.visibleText.includes('VISIBLE-SECOND') });
  check('document order preserved: answer then prose',
    JSON.stringify(vtu.order) === JSON.stringify(['answer', 'prose']), vtu.order);

  const utv = await cdp.eval(RENDER('UNTERM_THEN_VALID'));
  check('unterminated notes BEFORE a valid answer does not swallow it (answer survives)', utv.answerCount === 1, { answerCount: utv.answerCount });
  check('the answer holds DECISION-TWO', utv.answerText.join(' ').includes('DECISION-TWO'), utv.answerText);
  check('DECISION-TWO is VISIBLE without expanding anything (the hiding regression)',
    utv.visibleText.includes('DECISION-TWO'), utv.visibleText.replace(/\s+/g, ' ').slice(0, 120));
  check('the decision is NOT inside the notes fold', !utv.notesBodyText.join(' ').includes('DECISION-TWO'), utv.notesBodyText);
  check('the narration before it still renders as notes, in place', utv.notesCount === 1 && utv.notesBodyText.join(' ').includes('NARRATION-ONE'), { notesCount: utv.notesCount });
  check('document order preserved: notes then answer',
    JSON.stringify(utv.order) === JSON.stringify(['notes', 'answer']), utv.order);

  const nop = await cdp.eval(RENDER('UNPARSEABLE'));
  check('a message with no parseable structure renders as ONE prose node', nop.proseCount === 1 && nop.answerCount === 0 && nop.notesCount === 0,
    { proseCount: nop.proseCount, answerCount: nop.answerCount, notesCount: nop.notesCount });
  check('...and both of its sentences are readable', nop.visibleText.includes('NOPARSE-ONE') && nop.visibleText.includes('NOPARSE-TWO'), nop.visibleText.slice(0, 60));

  /* ------------------ [P] renderer ⇄ Stop-hook divergence attack ----------- */
  console.log('\n=== [P] ONE grammar, two consumers: renderer ⇄ Stop hook must never disagree ===');

  // P.0 — RUNTIME module identity. Two copies that merely started identical is
  // exactly the failure this section exists to catch, so prove one file.
  const HOOK_FILE = path.join(ROOT, 'scripts', 'hooks', 'response-format-gate.mjs');
  const hookSrc = fs.readFileSync(HOOK_FILE, 'utf8');
  const HOOK_SPEC = '../../public/lib/response-blocks.js';
  check('the Stop hook imports the grammar by the shared path (source-of-truth read)',
    hookSrc.includes(`import('${HOOK_SPEC}')`), HOOK_SPEC);
  const fromHook = fs.realpathSync(path.resolve(path.dirname(HOOK_FILE), HOOK_SPEC));
  const served = fs.realpathSync(path.join(ROOT, 'public', 'lib', 'response-blocks.js'));
  check('...and that specifier resolves to the very file the browser is served', fromHook === served, { fromHook, served });
  const diskBytes = fs.readFileSync(fromHook);
  const diskHash = crypto.createHash('sha256').update(diskBytes).digest('hex');
  const servedHash = await cdp.eval(`(async () => {
    const t = await (await fetch('/lib/response-blocks.js')).text();
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
  })()`);
  check('the bytes the browser LOADS are the bytes the hook imports (sha256)', servedHash === diskHash, { servedHash: servedHash.slice(0, 16), diskHash: diskHash.slice(0, 16) });
  // "Exactly one grammar module" is a property of the TREE, not of git — a
  // clean-room export has no .git, and failing there says nothing about the code.
  // Prefer git (it excludes build output and ignored scratch); fall back to a
  // filesystem walk; skip only if neither is possible, with the reason stated.
  {
    const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next']);
    const walk = (dir, out = []) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (IGNORE.has(e.name)) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (/^response-blocks\.(?:mjs|js|ts)$/.test(e.name)) out.push(path.relative(ROOT, p));
      }
      return out;
    };
    const g = spawnSync('git', ['ls-files', '--', '*response-blocks*'], { cwd: ROOT, encoding: 'utf8' });
    const gitUsable = g.status === 0 && !g.error;
    const found = gitUsable
      ? g.stdout.split('\n').map((s) => s.trim()).filter((s) => /(?:^|\/)response-blocks\.(?:mjs|js|ts)$/.test(s))
      : walk(ROOT);
    check(`exactly ONE grammar module exists in the tree, no copy that can drift (via ${gitUsable ? 'git ls-files' : 'filesystem walk — no usable git in this tree'})`,
      found.length === 1 && found[0] === path.join('public', 'lib', 'response-blocks.js'), found);
  }

  // P.1 — the two IMPORTS, on the same corpus, must produce identical parses. The
  // normaliser is written ONCE and evaluated on both sides, so the comparison
  // itself cannot drift.
  const NORM_SRC = `(p) => ({
    shape: p.shape, counts: p.counts, malformed: p.malformed,
    blockChars: p.blockChars, fallbackChars: p.fallbackChars, totalChars: p.totalChars,
    blocks: p.blocks.map((b) => [b.name, b.startLine, b.endLine, b.fence, b.chars, b.content]),
    unknown: p.unknownBlocks.map((u) => [u.name, u.chars]),
    runs: p.fallbackRuns.map((r) => [r.position, r.startLine, r.chars, r.lines, r.words, r.tags.join('+'), r.text]),
  })`;
  const nodeGrammar = await import(pathToFileURL(fromHook).href);
  const normNode = (0, eval)(NORM_SRC);
  await cdp.eval(`(async () => {
    const m = await import('/lib/response-blocks.js');
    window.__grammar = m; window.__norm = ${NORM_SRC};
    window.__CORP = ${JSON.stringify(CORPUS.map((c) => c.text))};
    return true;
  })()`);

  for (const [idx, item] of CORPUS.entries()) {
    const mine = JSON.stringify(normNode(nodeGrammar.parseResponseBlocks(item.text)));
    const theirs = await cdp.eval(`JSON.stringify(window.__norm(window.__grammar.parseResponseBlocks(window.__CORP[${idx}])))`);
    check(`parse parity (hook import ⇄ browser import): ${item.tag}`, mine === theirs,
      mine === theirs ? `identical (${mine.length} chars)` : { node: mine.slice(0, 300), browser: String(theirs).slice(0, 300) });
  }

  // P.2 — the REAL Stop hook, as a child process over a real transcript, must
  // record exactly what the BROWSER parsed. This is the metrics half of the
  // claim: what the reader sees and what the block-vocabulary decision is made
  // from are the same accounting.
  const metricsFile = path.join(DATA, 'logs', 'response-format-metrics.jsonl');
  const lastRecord = () => {
    try {
      const ls = fs.readFileSync(metricsFile, 'utf8').split('\n').filter((l) => l.trim());
      return JSON.parse(ls[ls.length - 1]);
    } catch { return null; }
  };
  for (const [idx, item] of CORPUS.entries()) {
    const tfile = path.join(TX, `t${idx}.jsonl`);
    fs.writeFileSync(tfile, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: item.text }] } }),
    ].join('\n') + '\n');
    const r = spawnSync(process.execPath, [HOOK_FILE], {
      input: JSON.stringify({ session_id: SUITE_SESSION_ID, hook_event_name: 'Stop', stop_hook_active: false, transcript_path: tfile, cwd: '/nonexistent/proj' }),
      encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, ORCHARD_SESSION: SUITE_SESSION_ID, CLAUDE_STATION_DATA: DATA, ORCHARD_STOP_HOOK_ENFORCE: '', ORCHARD_STOP_HOOK_DISABLED: '' },
    });
    const rec = lastRecord();
    // What the BROWSER says the same message contains, in the record's own shape.
    const expected = await cdp.eval(`(() => {
      const p = window.__grammar.parseResponseBlocks(window.__CORP[${idx}]);
      return JSON.stringify({
        shape: p.shape, counts: p.counts, malformed: p.malformed,
        unknownBlocks: p.unknownBlocks.map((u) => u.name),
        blockChars: p.blockChars, fallbackChars: p.fallbackChars, totalChars: p.totalChars,
        fallbackRunsTotal: p.fallbackRuns.length,
        runs: p.fallbackRuns.slice(0, 12).map((r) => [r.position, r.chars, r.lines, r.words, r.tags.join('+')]),
      });
    })()`);
    const actual = rec && JSON.stringify({
      shape: rec.shape, counts: rec.counts, malformed: rec.malformed,
      unknownBlocks: rec.unknownBlocks, blockChars: rec.blockChars, fallbackChars: rec.fallbackChars,
      totalChars: rec.totalChars, fallbackRunsTotal: rec.fallbackRunsTotal,
      runs: (rec.fallbackRuns ?? []).map((r) => [r.position, r.chars, r.lines, r.words, r.tags.join('+')]),
    });
    check(`hook PROCESS record == browser parse: ${item.tag}`, r.status === 0 && actual === expected,
      actual === expected ? `identical (hook exit ${r.status})` : { exit: r.status, hook: String(actual).slice(0, 260), browser: String(expected).slice(0, 260) });
  }

  // P.3 — CONTENT ATTRIBUTION in the real DOM: every authored token must land in
  // the region the parser says it is in, exactly once, in document order — and
  // nothing may be folded away except content the author put in `orchard-notes`.
  const ATTRIB = (idx) => `(() => {
    const host = document.getElementById('f091-probe') || (() => {
      const h = document.createElement('div'); h.id = 'f091-probe'; document.body.appendChild(h); return h;
    })();
    host.replaceChildren();
    host.appendChild(window.__f091.renderAssistantText(window.__CORP[${idx}], { enabled: true, projectId: null }));
    const kindOf = (n) => {
      let e = n.parentElement, hidden = false;
      while (e && e.id !== 'f091-probe') {
        if (e.tagName === 'DETAILS' && e.classList.contains('orchard-notes')) return { kind: 'notes', hidden: !e.open };
        if (e.classList.contains('orchard-answer')) return { kind: 'answer', hidden };
        if (e.classList.contains('digest')) return { kind: 'digest', hidden };
        e = e.parentElement;
      }
      return { kind: 'prose', hidden };
    };
    const out = [];
    const w = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      for (const m of String(n.nodeValue).matchAll(/TK\\d\\d/g)) {
        const k = kindOf(n);
        out.push([m[0], k.kind, k.hidden]);
      }
    }
    return out;
  })()`;

  for (const [idx, item] of CORPUS.entries()) {
    const parsed = nodeGrammar.parseResponseBlocks(item.text);
    const TOK = /TK\d\d/g;
    const srcTokens = item.text.match(TOK) ?? [];
    // Expected region per token, from the PARSE (the hook's view of the message).
    const expectMap = {};
    for (const b of parsed.blocks) {
      const kind = b.name === 'orchard-answer' ? 'answer' : b.name === 'orchard-notes' ? 'notes' : 'digest';
      for (const t of b.content.match(TOK) ?? []) expectMap[t] = kind;
    }
    for (const r of parsed.fallbackRuns) for (const t of r.text.match(TOK) ?? []) expectMap[t] = 'prose';
    if (item.wholeProse) for (const t of srcTokens) expectMap[t] = 'prose';

    const dom = await cdp.eval(ATTRIB(idx));
    const domTokens = dom.map((d) => d[0]);
    check(`attribution — every token rendered exactly once, in order: ${item.tag}`,
      JSON.stringify(domTokens) === JSON.stringify(srcTokens),
      JSON.stringify(domTokens) === JSON.stringify(srcTokens) ? `${srcTokens.length} tokens in order` : { src: srcTokens, dom: domTokens });
    // Key order is an artefact of how each side walks the message, not part of
    // the claim — compare the MAPPINGS, sorted by token.
    const sortMap = (m) => JSON.stringify(Object.entries(m).sort(([a], [z]) => a.localeCompare(z)));
    const domMap = Object.fromEntries(dom.map((d) => [d[0], d[1]]));
    check(`attribution — DOM region matches the parsed region: ${item.tag}`,
      sortMap(domMap) === sortMap(expectMap),
      sortMap(domMap) === sortMap(expectMap) ? 'identical' : { dom: domMap, parse: expectMap });
    const wronglyHidden = dom.filter((d) => d[2] && expectMap[d[0]] !== 'notes').map((d) => d[0]);
    check(`nothing is folded away except authored orchard-notes: ${item.tag}`, wronglyHidden.length === 0, wronglyHidden);
  }

  /* --------------- [K] keyboard + screen-reader reachability of the fold --- */
  console.log('\n=== [K] the fold is REALLY reachable: real key events + a real AX tree ===');
  await cdp.eval(RENDER('NOTES_ONLY'));
  await cdp.send('DOM.enable');
  await cdp.send('Accessibility.enable');
  const press = async (key, code, vk, text) => {
    await cdp.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, text });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await sleep(20);
  };
  await cdp.eval(`document.activeElement?.blur?.(); document.body.focus(); true`);
  const isOnSummary = `(() => { const a = document.activeElement; return !!a && a.tagName === 'SUMMARY' && a.classList.contains('orchard-notes-sum'); })()`;
  let tabs = 0, reached = false;
  while (tabs < 300 && !reached) { await press('Tab', 'Tab', 9); tabs++; reached = await cdp.eval(isOnSummary); }
  check('TAB traversal actually lands on the notes summary (real key events)', reached, { tabs });
  await press('Enter', 'Enter', 13, '\r');
  const openedByEnter = await cdp.eval(`!!document.querySelector('#f091-probe details.orchard-notes')?.open`);
  check('ENTER on the focused summary OPENS the fold', openedByEnter, { open: openedByEnter });
  const bodyVisible = await cdp.eval(`(() => {
    const b = document.querySelector('#f091-probe .orchard-notes-body');
    return !!b && b.getClientRects().length > 0 && b.textContent.includes('walked the parser');
  })()`);
  check('...and the narration is then really laid out on screen', bodyVisible, { bodyVisible });
  await press(' ', 'Space', 32, ' ');
  const closedBySpace = await cdp.eval(`!document.querySelector('#f091-probe details.orchard-notes')?.open`);
  check('SPACE closes it again (keyboard round trip, no mouse anywhere)', closedBySpace, { closed: closedBySpace });

  // The screen-reader view: read the real accessibility tree, not the markup.
  const axFor = async () => {
    const doc = await cdp.send('DOM.getDocument', { depth: 1 });
    const found = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#f091-probe details.orchard-notes > summary' });
    if (!found.nodeId) return null;
    const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { nodeId: found.nodeId, fetchRelatives: true });
    return nodes;
  };
  const axClosed = await axFor();
  const summaryAx = (axClosed ?? []).find((n) => (n.name?.value ?? '').toLowerCase().includes('notes') && !n.ignored);
  check('the summary is a NON-IGNORED node in the accessibility tree', !!summaryAx,
    (axClosed ?? []).map((n) => `${n.role?.value}:${(n.name?.value ?? '').slice(0, 24)}${n.ignored ? '(ignored)' : ''}`).slice(0, 8));
  check('...exposed with a disclosure/button-shaped role, not a bare div',
    ['DisclosureTriangle', 'button', 'Button', 'group'].includes(summaryAx?.role?.value ?? ''), summaryAx?.role?.value);
  check('...and its accessible NAME says what it is ("Notes")',
    /notes/i.test(summaryAx?.name?.value ?? ''), summaryAx?.name?.value);
  const expandedProp = (nodes) => {
    for (const n of nodes ?? []) {
      const p = (n.properties ?? []).find((x) => x.name === 'expanded');
      if (p) return p.value?.value;
    }
    return undefined;
  };
  check('the COLLAPSED state is announced (expanded=false), not just drawn', expandedProp(axClosed) === false, { expanded: expandedProp(axClosed) });
  const axSearchClosed = await cdp.send('Accessibility.getFullAXTree');
  const treeHas = (t, s) => JSON.stringify(t.nodes.filter((n) => !n.ignored)).includes(s);
  check('a screen reader does NOT see the folded narration while it is closed',
    !treeHas(axSearchClosed, 'walked the parser'), 'absent while closed');
  await cdp.eval(`document.querySelector('#f091-probe details.orchard-notes').open = true; true`);
  await sleep(80);
  const axOpen = await axFor();
  check('expanding announces expanded=true', expandedProp(axOpen) === true, { expanded: expandedProp(axOpen) });
  const axSearchOpen = await cdp.send('Accessibility.getFullAXTree');
  check('...and the narration then IS in the accessibility tree (reachable, not decorative)',
    treeHas(axSearchOpen, 'walked the parser'), 'present when open');
  await cdp.eval(`document.getElementById('f091-probe')?.replaceChildren(); true`);

  /* ---------------------------------------- [S] the SEMANTIC vocabulary (r12)
   * The rename is only worth anything if the reader can SEE the categories, so
   * this leg asks the reader-facing questions in the real DOM and the real
   * accessibility tree: is every visible category captioned, does exactly one
   * category fold, is the declared fallback shown with the author's own words,
   * and does an archived legacy message still render the way it always did. */
  console.log('\n=== [S] semantic categories: captioned, one fold, fallback visible ===');
  const sem = await cdp.eval(RENDER('SEMANTIC'));
  check('the four reader-addressed categories + the fallback render visibly (5 blocks)',
    sem.answerCount === 5, { visibleBlocks: sem.answerCount, cats: sem.cats });
  // THE HIDING SURFACE, asked as the RULE and not as a count. Round 13 folded
  // `finding` as well, so "exactly one folds" was a description of the set, not
  // the invariant. The invariant is that nothing ADDRESSED TO THE READER folds.
  check('the supporting record folds — finding and narration, both closed',
    sem.notesCount === 2 && sem.notesOpen.every((o) => o === false)
      && JSON.stringify(sem.cats.filter((c) => ['ob-finding', 'ob-narration'].includes(c)))
        === JSON.stringify(['ob-finding', 'ob-narration']),
    { folds: sem.notesCount, open: sem.notesOpen, cats: sem.cats });
  check('nothing addressed to the reader is behind a fold',
    ['SEM-OUTCOME', 'SEM-ASK', 'SEM-JUDGMENT', 'SEM-STATUS', 'SEM-UNCAT']
      .every((t) => sem.visibleText.includes(t) && !sem.notesBodyText.join(' ').includes(t)),
    sem.notesBodyText.map((t) => t.slice(0, 40)));
  check('each visible category carries its own caption, in document order',
    JSON.stringify(sem.caps) === JSON.stringify(['Changed', 'Needs you', 'My call', 'Where things stand', 'Uncategorised']),
    sem.caps);
  check('the category classes are distinct per block (presentation derives from the name)',
    JSON.stringify(sem.cats.filter((c) => !['ob-narration', 'ob-finding'].includes(c))) ===
      JSON.stringify(['ob-outcome', 'ob-ask', 'ob-judgment', 'ob-status', 'ob-uncat']),
    sem.cats);
  check('the DECLARED fallback is rendered, not hidden, and shows the author label',
    sem.visibleText.includes('SEM-UNCAT') && sem.capNotes.includes('a copy-paste prompt for you to run'),
    { capNotes: sem.capNotes });
  check('every visible category body is readable WITHOUT interacting',
    ['SEM-OUTCOME', 'SEM-ASK', 'SEM-JUDGMENT', 'SEM-STATUS'].every((t) => sem.visibleText.includes(t)),
    sem.visibleText.slice(0, 80));
  check('the narration is folded away — present in the DOM, absent from the visible text',
    sem.text.includes('SEM-NARRATION') && !sem.visibleText.includes('SEM-NARRATION'),
    { inDom: sem.text.includes('SEM-NARRATION'), visible: sem.visibleText.includes('SEM-NARRATION') });
  // THE FINDING FOLD IS RETRIEVABLE, NOT HIDDEN — the whole point of the preview.
  // Two claims, and both must hold or the feature is the wrong one: the body is
  // genuinely behind the click, and the first sentence is genuinely NOT.
  check('the finding BODY is folded away — in the DOM, not in the visible text',
    sem.text.includes('SEM-FINDING-BODY') && !sem.visibleText.includes('SEM-FINDING-BODY'),
    { inDom: sem.text.includes('SEM-FINDING-BODY'), visible: sem.visibleText.includes('SEM-FINDING-BODY') });
  check("the finding's FIRST SENTENCE is readable without interacting (the preview)",
    sem.visibleText.includes('SEM-FINDING —') && !sem.visibleText.includes('SEM-FINDING-BODY'),
    sem.notesSummary);
  check('the preview is one SENTENCE, not the whole block',
    sem.notesPrev[0] !== null && sem.notesPrev[0].endsWith('as finished.')
      && !sem.notesPrev[0].includes('still in review'),
    sem.notesPrev);
  // A NARRATION FOLD GETS NO PREVIEW — presentation is per CATEGORY, so this is
  // what proves the flag is read rather than the fold branch being blanket. The
  // fold order is finding then narration, as authored.
  check('exactly one fold carries a preview, and it is the finding',
    sem.notesPrev.length === 2 && typeof sem.notesPrev[0] === 'string' && sem.notesPrev[1] === null,
    sem.notesPrev);
  check('nothing was lost: every authored region is somewhere in the render',
    ['SEM-FINDING', 'SEM-FINDING-BODY', 'SEM-OUTCOME', 'SEM-ASK', 'SEM-JUDGMENT', 'SEM-STATUS', 'SEM-NARRATION', 'SEM-UNCAT']
      .every((t) => sem.text.includes(t)), 'all present');
  {
    // The screen-reader read of the same claim: captions are real text nodes, the
    // ask is reachable, the narration is not — asked of the AX tree, never markup.
    const axSem = await cdp.send('Accessibility.getFullAXTree');
    const axSemText = JSON.stringify(axSem.nodes.filter((n) => !n.ignored));
    check('a screen reader reaches the ask AND its category caption',
      axSemText.includes('SEM-ASK') && axSemText.includes('Needs you'), 'ask + caption in AX tree');
    check('...and does NOT reach the folded narration while it is closed',
      !axSemText.includes('SEM-NARRATION'), 'absent while closed');
    // The preview is a real text node on the summary, so a screen reader gets the
    // same triage the eye does — and the body it stands for stays behind the click.
    check('a screen reader reads the finding PREVIEW but not the finding body',
      axSemText.includes('SEM-FINDING —') && !axSemText.includes('SEM-FINDING-BODY'),
      'preview reachable, body not');
  }
  await cdp.eval(`document.getElementById('f091-probe')?.replaceChildren(); true`);

  console.log('\n=== [S2] MIGRATION: an archived legacy message renders as it always did ===');
  const leg = await cdp.eval(RENDER('LEGACY_MIX'));
  check('legacy orchard-answer still renders visible', leg.visibleText.includes('LEG-ANSWER'), leg.visibleText.slice(0, 60));
  check('legacy orchard-answer is UNDECORATED — no caption is retro-fitted to old content',
    leg.caps.length === 0, leg.caps);
  check('legacy orchard-notes still folds, with its original summary',
    leg.notesCount === 1 && leg.notesOpen[0] === false && /notes/i.test(leg.notesSummary.join(' ')),
    { folds: leg.notesCount, summary: leg.notesSummary });
  check('legacy narration is still hidden while closed, and still present in the DOM',
    leg.text.includes('LEG-NOTES') && !leg.visibleText.includes('LEG-NOTES'), 'folded');
  await cdp.eval(`document.getElementById('f091-probe')?.replaceChildren(); true`);

  /* ------------------------------------------- [Q] the generated property leg
   * The hand-written scenes above are the shapes someone thought of. Twice now the
   * shape nobody thought of — one more layer of nesting — shipped a reader's
   * decision inside a CLOSED fold. So the enumerated corpus
   * (scripts/lib/feat-091-fold-corpus.mjs, the same cases the parser verifier
   * grades) is driven through the REAL renderer in the REAL browser, and graded on
   * RENDERED TEXT and the REAL accessibility tree — never on DOM structure, because
   * content inside a closed fold is present in the markup and absent to the reader,
   * which is exactly how both defects passed their suites. */
  console.log('\n=== [Q] generated corpus through the real renderer: nothing authored outside notes is folded ===');
  {
    const { generateCorpus, reportedDefectCases, gradeRender, remapCorpus } =
      await import(pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'feat-091-fold-corpus.mjs')).href);
    // ROUND 12 — EXTENDED, not replaced. The enumerated corpus is rendered twice:
    // as authored (legacy `orchard-notes` — the migration case, since stored
    // transcripts are full of it) and remapped onto `orchard-narration`. The
    // hiding surface has to hold under BOTH names in the real browser, or the
    // rename moved the defect rather than the vocabulary.
    const authored = [...generateCorpus(), ...reportedDefectCases()];
    const all = [...authored, ...remapCorpus(authored)];
    // Render every case that can produce a fold at all (a collapsed opener
    // anywhere), plus every depth-1 case as the control. That is the whole hiding
    // surface; cases with no collapsed opener cannot hide anything by construction.
    const corpus = all.filter((c) => c.shape === 'reported' || c.shape === 'depth1'
      || c.text.includes('orchard-notes') || c.text.includes('orchard-narration'));

    await cdp.eval(`document.getElementById('f091-probe').replaceChildren(); window.__q = []; true`);
    const CHUNK = 120;
    for (let at = 0; at < corpus.length; at += CHUNK) {
      const batch = corpus.slice(at, at + CHUNK).map((c) => ({ id: c.id, text: c.text }));
      await cdp.eval(`(async () => {
        const m = await import('/lib/digest.js');
        const host = document.getElementById('f091-probe');
        for (const c of ${JSON.stringify(batch)}) {
          const cell = document.createElement('div');
          cell.className = 'q-case';
          cell.append(m.renderAssistantText(c.text, { enabled: true, projectId: null }));
          host.append(cell);
          let hidden = '';
          for (const d of cell.querySelectorAll('details')) {
            if (!d.open) hidden += '\\n' + (d.querySelector('.orchard-notes-body')?.textContent ?? '');
          }
          const clone = cell.cloneNode(true);
          for (const d of clone.querySelectorAll('details')) {
            if (!d.open) d.querySelector('.orchard-notes-body')?.remove();
          }
          window.__q.push({ id: c.id, visible: clone.textContent, hidden });
        }
        return true;
      })()`);
    }
    const rendered = await cdp.eval(`window.__q.map((r) => [r.id, r.visible, r.hidden])`);
    const byId = new Map(rendered.map(([id, visible, hidden]) => [id, { visible, hidden }]));
    const violations = [];
    let threw = 0, foldedCases = 0;
    for (const c of corpus) {
      const got = byId.get(c.id);
      if (!got) { threw++; violations.push(`${c.id}: never rendered`); continue; }
      if (got.hidden.trim()) foldedCases++;
      for (const v of gradeRender(c, got)) violations.push(`${c.id}: ${v}`);
    }
    console.log(`        rendered ${corpus.length} generated cases (of ${all.length} enumerated); ${foldedCases} produced a closed fold`);
    check(`every one of the ${corpus.length} generated cases rendered without throwing`, threw === 0, { threw });
    check('R1 — no content authored outside notes is inside a CLOSED fold, in the real render',
      violations.filter((v) => v.includes('R1')).length === 0, violations.filter((v) => v.includes('R1')).slice(0, 4));
    check('R2 — no generated region vanished from the render entirely',
      violations.filter((v) => v.includes('R2')).length === 0, violations.filter((v) => v.includes('R2')).slice(0, 4));
    // R3 — THE FOLD-LOST DIRECTION. R1/R2 can only see content ESCAPING a fold;
    // neither can see a fold being LOST, which is why the render leg stayed silent
    // through the round-10 defect (a well-formed `orchard-notes` block that a
    // multi-line link-reference definition made classify as literal prose — its
    // narration rendered in the open, nothing hidden and nothing vanished, so R1
    // and R2 both passed). gradeRender emits R3 when a token a WELL-FORMED case
    // authored inside orchard-notes is NOT in a closed fold in the real render.
    check('R3 — no authored orchard-notes fold was LOST (rendered open instead of folded)',
      violations.filter((v) => v.includes('R3')).length === 0, violations.filter((v) => v.includes('R3')).slice(0, 4));
    check('the render leg is not vacuous: it really produced folds', foldedCases > 100, { foldedCases });

    // The screen-reader read. One full AX tree over a bounded, hiding-risk subset:
    // every case that both produced a fold AND carries a must-be-visible region.
    const risky = corpus.filter((c) => byId.get(c.id)?.hidden.trim() && c.tokens.some((t) => t.mustBeVisible));
    const AX_CAP = 220;
    const stride = Math.max(1, Math.ceil(risky.length / AX_CAP));
    // Every REPORTED defect input is read by the screen reader unconditionally —
    // a stride sample must never be the reason the actual reported bug goes
    // ungraded in the one place the hiding is observable.
    const forced = risky.filter((c) => c.shape === 'reported');
    const axCases = [...forced, ...risky.filter((c, k) => c.shape !== 'reported' && k % stride === 0)].slice(0, AX_CAP);
    console.log(`        AX read over ${axCases.length} of ${risky.length} fold-bearing risky cases (all ${forced.length} reported inputs forced in)`);
    await cdp.eval(`document.getElementById('f091-probe').replaceChildren(); true`);
    await cdp.eval(`(async () => {
      const m = await import('/lib/digest.js');
      const host = document.getElementById('f091-probe');
      for (const c of ${JSON.stringify(axCases.map((c) => ({ text: c.text })))}) {
        const cell = document.createElement('div');
        cell.append(m.renderAssistantText(c.text, { enabled: true, projectId: null }));
        host.append(cell);
      }
      return true;
    })()`);
    await sleep(150);
    const axTree = await cdp.send('Accessibility.getFullAXTree');
    /* The DISCLOSURE CONTROL's own accessible name is the fold's LABEL, never
     * authored content — and round 12's label for a collapsed block is the word
     * "Narration", which Chrome computes (uppercased by the summary's
     * text-transform) as part of that control's name. Left in, it collides with
     * the corpus's own `NARRATION` token and reports a leak while the fold is
     * genuinely closed: a false alarm on this exact check is how a real one gets
     * ignored. The control is excluded here and asserted separately in [K],
     * where its name is the thing under test rather than the noise. */
    const axText = (() => {
      const byId = new Map(axTree.nodes.map((n) => [n.nodeId, n]));
      const drop = new Set();
      for (const n of axTree.nodes) {
        if (n.role?.value !== 'DisclosureTriangle') continue;
        // The control AND its label text nodes: the summary renders the label in
        // child spans, so excluding only the control leaves the same word behind.
        const stack = [n.nodeId];
        while (stack.length) {
          const id = stack.pop();
          if (drop.has(id)) continue;
          drop.add(id);
          for (const kid of byId.get(id)?.childIds ?? []) stack.push(kid);
        }
      }
      // The exclusion must not become a hiding place: whatever it removes has to
      // be CHROME, not content. Every dropped name is checked against the fold's
      // own vocabulary, so a renderer that ever put authored text inside a
      // summary would fail here instead of quietly disappearing from the read.
      const droppedNames = axTree.nodes.filter((n) => drop.has(n.nodeId))
        .map((n) => (n.name?.value ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);
      const CHROME = /^(NARRATION|NOTES|▸)?( ?(what i did this turn|internal narration))?$/i;
      check('the AX summary exclusion removes CHROME only (it cannot become a hiding place)',
        droppedNames.every((n) => CHROME.test(n)),
        droppedNames.filter((n) => !CHROME.test(n)).slice(0, 3));
      return JSON.stringify(axTree.nodes.filter((n) => !n.ignored && !drop.has(n.nodeId)));
    })();
    let axMissing = 0, axLeaked = 0;
    const axDetail = [];
    const axLeakDetail = [];
    /* HARNESS INTEGRITY. The AX read is ONE tree over MANY cases on one page, so
     * a plain `includes` asks "is this string anywhere", and the corpus's token
     * names NEST: `NARRATION` is a prefix of `NARRATION-R3`, `TILDE-NARRATION`,
     * `R10-NARRATION`. A case that correctly PROMOTES its narration to visible
     * (the round-3 lone-CR case does exactly that, by design) therefore made a
     * different case's genuinely-folded `NARRATION` look like a leak. That is a
     * mis-graded case — the failure mode the duplicate-id check above exists for,
     * one level down — so token matching is delimited, not substring. */
    const hasTok = (hay, tok) =>
      new RegExp(`(?<![A-Za-z0-9-])${tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9-])`).test(hay);
    for (const c of axCases) {
      const got = byId.get(c.id);
      for (const t of c.tokens) {
        if (t.mustBeVisible && !hasTok(axText, t.tok)) { axMissing++; if (axDetail.length < 4) axDetail.push(`${c.id}: ${t.tok} not in AX tree`); }
        if (!t.mustBeVisible && hasTok(got.hidden, t.tok) && hasTok(axText, t.tok)) {
          axLeaked++;
          if (axLeakDetail.length < 4) axLeakDetail.push(`${c.id}: ${t.tok}`);
        }
      }
    }
    check(`AX — every must-be-visible region of ${axCases.length} fold-bearing cases is in the real accessibility tree`,
      axMissing === 0, { axMissing, examples: axDetail });
    check('AX — folded narration is genuinely absent from the accessibility tree (the fold really hides)',
      axLeaked === 0, { axLeaked, examples: axLeakDetail });
    await cdp.eval(`document.getElementById('f091-probe').replaceChildren(); delete window.__q; true`);
  }

  /* ═══════════ [R] the RANDOMISED corpus, rendered in the real browser ══════
   * WHY THIS EXISTS. The eleventh independent pass returned HOLDS with exactly
   * one residual: `verify:feat-091-commonmark-diff` generates ~480,000 documents
   * a run and grades every one of them in NODE, against the CommonMark reference
   * — and never renders a single one. The browser leg covered three fixed shapes.
   *
   * That is not an incidental gap; it is the shape of the TENTH defect one level
   * up. Round 10 passed every parser-level check it had and was caught only when
   * a verifier rendered the input in a real browser and read the accessibility
   * tree. A randomised space explored only where the reader is not is the same
   * blind spot, with a much bigger number attached to it.
   *
   * SO: a sample of that exact space — the same generator, imported from the same
   * module (scripts/lib/feat-091-fold-corpus.mjs), never a second copy — is
   * rendered through the app's own renderer in this browser and graded on
   * RENDERED TEXT plus the real accessibility tree, with the CommonMark reference
   * as the oracle in BOTH directions:
   *   literal region -> the token must reach the reader (the hiding direction)
   *   live region    -> the token must really be inside a closed fold (the
   *                     fold-lost direction, which no structural check can see)
   *
   * SAMPLING — the judgement, made from a measurement rather than a round number.
   * The per-document browser cost was measured in this rig before the size was
   * chosen, and it is re-measured and PRINTED on every run so the choice cannot
   * go stale: 0.13 ms/document, flat from 100 to 20,000 documents (2.5s for
   * 20,000). It is that cheap because grading needs the DOM and the fold state,
   * not a paint — the expensive parts (layout, the accessibility tree, pixels)
   * are the ones that stay capped, at 150 documents and at the [T] leg below.
   *
   * Given that measurement, the size is pinned to a PROPERTY rather than a
   * number: the browser renders as many documents per run as the node
   * differential grades per run (its FUZZ_N default is 20,000). The render leg is
   * therefore no longer a rounding error beside the node leg — every run, the two
   * cover comparable ground, and the residual the eleventh pass named ("graded in
   * node only") is answered on the differential's own terms. The pool is 6x the
   * sample so the strata have something to select from rather than taking
   * everything they can find. See FUZZ_STRATA and pickFuzzSample in the corpus
   * module for the strata and why each one is there.
   * FEAT091_RENDER_SAMPLE / _POOL / _SEED / _CAL widen or replay it.
   *
   * WHAT THIS DOES NOT COVER, stated because a sample that hides its own bound is
   * worse than no sample:
   *   - It is 20,000 of 120,000 generated documents, and the generated space is
   *     unbounded. It is a filter for defect CLASSES dense enough to appear at a
   *     ~1-in-20,000 rate in the stratified sample; a class rarer than that can
   *     still pass a green run. (Round 9's own defect direction shows up at 0.6%
   *     here, round 7's at 21% — both far above that floor, which is why the
   *     calibration below can require a FLOOR of hits and not merely one.)
   *   - Only ~150 of the sampled documents get an accessibility-tree read, and
   *     only two hand-built folds get a pixel read ([T]). A defect that is
   *     invisible in rendered text AND rare would need both to be widened.
   *   - The oracle is the CommonMark reference, so any question the reference
   *     itself answers differently from the spec is invisible to this leg in
   *     exactly the way it is invisible to the node differential.
   * The node differential remains the wide leg; this is the leg that puts the
   * reader in the room. */
  console.log('\n=== [R] a stratified sample of the RANDOMISED corpus, rendered for real ===');
  const RENDER_SEED = Number(process.env.FEAT091_RENDER_SEED || (Date.now() % 2147483647));
  const RENDER_POOL = Number(process.env.FEAT091_RENDER_POOL || 120000);
  const RENDER_SAMPLE = Number(process.env.FEAT091_RENDER_SAMPLE || 20000);
  {
    const { rngFrom, fuzzDoc, FUZZ_TOKEN, fuzzDefectTags, pickFuzzSample, gradeFuzzRender, FUZZ_STRATA } =
      await import(pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'feat-091-fold-corpus.mjs')).href);

    let commonmark = null;
    try { commonmark = await import('commonmark'); } catch { /* devDependency absent */ }

    if (!commonmark) {
      // Same environment fact the sibling differential records: a clean-room
      // export strips node_modules and has no network. Counted, with the reason,
      // never silently skipped — and never `npm install`ed to un-skip, because a
      // clean room's node_modules symlinks into the live tree.
      check('[R] SKIPPED — the `commonmark` devDependency (the render oracle) is absent; clean-room export, do NOT install to un-skip',
        true, 'skip recorded as a pass with its reason, exactly as verify:feat-091-commonmark-diff does');
    } else {
      const reader = new commonmark.Parser();
      const { parseResponseBlocks } = nodeGrammar;
      /** The reference verdict: does a real `orchard-notes` fenced block open at
       *  the fence line, hold the token, and close at the close line? */
      const refLive = (input, fenceLine, closeLine) => {
        const ast = reader.parse(input);
        for (let w = ast.walker(), ev; (ev = w.next());) {
          if (!ev.entering) continue;
          const nd = ev.node;
          if (nd.type !== 'code_block' || !nd._isFenced) continue;
          if (nd.sourcepos[0][0] !== fenceLine || nd.sourcepos[1][0] !== closeLine) continue;
          if ((nd.info || '').trim().toLowerCase() !== 'orchard-notes') continue;
          if (!(nd.literal || '').includes(FUZZ_TOKEN)) continue;
          return true;
        }
        return false;
      };

      // Build and annotate the POOL in node (microseconds per document), then
      // choose the browser sample from it.
      const tPool = Date.now();
      const rnd = rngFrom(RENDER_SEED);
      const annotated = [];
      for (let k = 0; k < RENDER_POOL; k++) {
        const d = fuzzDoc(rnd);
        let live;
        try { live = refLive(d.input, d.fenceLine, d.closeLine); } catch { continue; }
        let uncertain = false;
        try { uncertain = parseResponseBlocks(d.input).malformed.length > 0; } catch { uncertain = true; }
        annotated.push({ input: d.input, live, uncertain, tags: fuzzDefectTags(d.input) });
      }
      const poolMs = Date.now() - tPool;
      const liveInPool = annotated.filter((e) => e.live).length;
      console.log(`        pool: ${annotated.length} documents annotated in ${poolMs}ms (${liveInPool} reference-LIVE, ${annotated.length - liveInPool} literal); seed=${RENDER_SEED} (replay with FEAT091_RENDER_SEED=${RENDER_SEED})`);

      const { picked, counts } = pickFuzzSample(annotated, { sample: RENDER_SAMPLE, rnd });
      console.log(`        sample: ${picked.length} documents, strata ${JSON.stringify(counts)}`);
      check('the sample is stratified, not a slice: every declared stratum contributed',
        FUZZ_STRATA.every((s) => (counts[s.tag] ?? 0) > 0), counts);
      check('the sample carries both oracle directions (fold-lost is only observable on LIVE documents)',
        picked.some((p) => p.live) && picked.some((p) => !p.live),
        { live: picked.filter((p) => p.live).length, literal: picked.filter((p) => !p.live).length });

      /* Render a list of documents through the app's OWN renderer, one detached
         cell each, and pull visible/hidden text out of the real DOM. Returned as
         a function so the non-vacuity calibration below can reuse it verbatim —
         a calibration that ran different code would prove nothing. */
      const renderBatch = async (docs) => {
        await cdp.eval(`document.getElementById('f091-probe').replaceChildren(); window.__r = []; true`);
        const CH = 100;
        for (let at = 0; at < docs.length; at += CH) {
          await cdp.eval(`(async () => {
            const m = await import('/lib/digest.js');
            const host = document.getElementById('f091-probe');
            for (const t of ${JSON.stringify(docs.slice(at, at + CH).map((d) => d.input))}) {
              const cell = document.createElement('div');
              cell.append(m.renderAssistantText(t, { enabled: true, projectId: null }));
              host.append(cell);
              let hidden = '';
              for (const d of cell.querySelectorAll('details')) {
                if (!d.open) hidden += '\\n' + (d.querySelector('.orchard-notes-body')?.textContent ?? '');
              }
              const clone = cell.cloneNode(true);
              for (const d of clone.querySelectorAll('details')) {
                if (!d.open) d.querySelector('.orchard-notes-body')?.remove();
              }
              window.__r.push([clone.textContent, hidden]);
              cell.remove();
            }
            return true;
          })()`);
        }
        return cdp.eval('window.__r');
      };

      const tRender = Date.now();
      const out = await renderBatch(picked);
      const renderMs = Date.now() - tRender;
      const perDoc = renderMs / Math.max(1, picked.length);
      console.log(`        MEASURED browser cost: ${renderMs}ms for ${picked.length} documents = ${perDoc.toFixed(2)}ms/document (the number the sample size is chosen from)`);

      check(`all ${picked.length} sampled documents rendered without throwing`, out.length === picked.length,
        { rendered: out.length, sampled: picked.length });

      const viol = { F1: [], F2: [], F3: [], F4: [] };
      let folded = 0;
      for (let k = 0; k < picked.length && k < out.length; k++) {
        const [visible, hidden] = out[k];
        if (hidden.trim()) folded++;
        for (const v of gradeFuzzRender(picked[k], { visible, hidden })) {
          viol[v.slice(0, 2)].push(`[${picked[k].stratum}] ${v}\n            input: ${JSON.stringify(picked[k].input).slice(0, 220)}`);
        }
      }
      check('F1 — a region the REFERENCE calls literal never renders inside a closed fold (the hiding direction)',
        viol.F1.length === 0, viol.F1.slice(0, 3));
      check('F2 — no sampled token vanished from the render entirely',
        viol.F2.length === 0, viol.F2.slice(0, 3));
      check('F3 — a region the REFERENCE calls a live orchard-notes fold really IS a closed fold (the fold-lost direction)',
        viol.F3.length === 0, viol.F3.slice(0, 3));
      check('F4 — the trailing TAIL line is always readable with no interaction',
        viol.F4.length === 0, viol.F4.slice(0, 3));
      check('the sampled render is not vacuous: it really produced folds',
        folded >= Math.min(20, Math.floor(picked.length * 0.05)), { foldedCases: folded, of: picked.length });

      /* The SCREEN-READER read over the sample. Same reason as [Q]: rendered text
         and the accessibility tree are two different questions, and round 10 was
         only visible in the second one. Bounded — a full AX tree is expensive —
         to the fold-bearing documents, which are the only ones that can hide. */
      const axPool = picked.filter((p, k) => out[k] && out[k][1].trim());
      const AX_CAP = 150;
      const axStride = Math.max(1, Math.ceil(axPool.length / AX_CAP));
      const axCases = axPool.filter((p, k) => k % axStride === 0).slice(0, AX_CAP);
      await cdp.eval(`document.getElementById('f091-probe').replaceChildren(); true`);
      await cdp.eval(`(async () => {
        const m = await import('/lib/digest.js');
        const host = document.getElementById('f091-probe');
        for (const t of ${JSON.stringify(axCases.map((c) => c.input))}) {
          const cell = document.createElement('div');
          cell.append(m.renderAssistantText(t, { enabled: true, projectId: null }));
          host.append(cell);
        }
        return true;
      })()`);
      await sleep(200);
      const axTree = await cdp.send('Accessibility.getFullAXTree');
      const axText = JSON.stringify(axTree.nodes.filter((n) => !n.ignored));
      const axTailMissing = !axText.includes('TAIL');
      // Every one of these documents folded; the reference says every one of them
      // SHOULD fold (they are the fold-bearing subset), so the folded token must
      // be absent from the tree and the TAIL after it must be present.
      const axLiveLeak = axCases.filter((c) => c.live).length > 0 && axText.includes(FUZZ_TOKEN)
        && axCases.every((c) => c.live);
      console.log(`        AX read over ${axCases.length} of ${axPool.length} fold-bearing sampled documents`);
      check('AX — the content after every sampled fold is in the real accessibility tree (TAIL reachable)',
        axCases.length === 0 || !axTailMissing, { axCases: axCases.length, tailPresent: !axTailMissing });
      check('AX — where every sampled fold is a genuine fold, the folded token is absent from the accessibility tree',
        !axLiveLeak, { allLive: axCases.every((c) => c.live), tokenInTree: axText.includes(FUZZ_TOKEN) });
      await cdp.eval(`document.getElementById('f091-probe').replaceChildren(); delete window.__r; true`);

      /* ── NON-VACUITY: this leg must FAIL on the generations it claims to catch.
       * A browser leg that cannot demonstrate it would have caught the defects we
       * already know about is decoration. So the SERVED parser bytes are swapped
       * for a pinned prior generation via CDP request interception — the real
       * renderer, the real browser, an old grammar — and this leg's own grader is
       * required to fire, in that generation's OWN defect direction.
       * Fixed shas, never a moving baseline. */
      // `floor` is a REQUIRED number of violations in that generation's own defect
      // direction, not merely >0: a calibration that passes on a single hit is one
      // unlucky shuffle away from a green run that proved nothing. Measured rates
      // over 20,000 rendered documents on this space are round 9 F3 ≈ 0.6% and
      // round 7 F1 ≈ 21%, so at the default 8,000-document calibration these
      // floors sit far below the expectation and far above zero.
      const CAL = [
        { sha: '91b35ab', label: 'round 9', want: 'F3', floor: 5, why: 'a multi-line link reference definition made a well-formed fold classify as literal — the fold is LOST' },
        { sha: '52807b9', label: 'round 7', want: 'F1', floor: 20, why: 'an unrecognised literal HTML region became a real fold — the reader\'s content is HIDDEN' },
      ];
      // The calibration set is a STRIDE through the sample, not its head: strata
      // are filled in order, so `slice(0, n)` would be the `uncertain` stratum
      // and nothing else, and a calibration that only ever replays one stratum
      // cannot speak for the leg. A stride keeps every stratum's share.
      const CAL_N = Math.min(picked.length, Number(process.env.FEAT091_RENDER_CAL || 8000));
      const calStride = Math.max(1, Math.floor(picked.length / CAL_N));
      const calDocs = picked.filter((_, k) => k % calStride === 0).slice(0, CAL_N);
      for (const gen of CAL) {
        const shown = spawnSync('git', ['show', `${gen.sha}:public/lib/response-blocks.js`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
        if (shown.status !== 0 || !shown.stdout) {
          check(`calibration ${gen.label} (${gen.sha}) SKIPPED — history unavailable in this tree (clean-room export has no .git)`, true, shown.stderr?.slice(0, 120) ?? 'no git');
          continue;
        }
        await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/lib/response-blocks.js', requestStage: 'Response' }] });
        const onPaused = (raw) => {
          const m = JSON.parse(raw.toString());
          if (m.method !== 'Fetch.requestPaused') return;
          cdp.send('Fetch.fulfillRequest', {
            requestId: m.params.requestId, responseCode: 200,
            responseHeaders: [{ name: 'content-type', value: 'text/javascript; charset=utf-8' }],
            body: Buffer.from(shown.stdout, 'utf8').toString('base64'),
          }).catch(() => { /* target gone */ });
        };
        cdp.ws.on('message', onPaused);
        // A module map is per-Document, so a fresh navigation is what makes the
        // page import the substituted bytes instead of the cached live module.
        await cdp.send('Page.navigate', { url: `${BASE}/?cal=${gen.sha}` });
        await cdp.waitFor('reboot', `!!document.querySelector('link[rel="stylesheet"]')`, 30_000);
        const served = await cdp.eval(`(async () => (await (await fetch('/lib/response-blocks.js')).text()).length)()`);
        await cdp.eval(`(async () => { const m = await import('/lib/digest.js'); window.__f091 = m; return true; })()`);
        await cdp.eval(`(() => { const h = document.createElement('div'); h.id = 'f091-probe'; document.body.appendChild(h); return true; })()`);
        let calOut = [];
        try { calOut = await renderBatch(calDocs); } catch (e) { calOut = []; }
        const calViol = { F1: 0, F2: 0, F3: 0, F4: 0 };
        for (let k = 0; k < calDocs.length && k < calOut.length; k++) {
          for (const v of gradeFuzzRender(calDocs[k], { visible: calOut[k][0], hidden: calOut[k][1] })) calViol[v.slice(0, 2)]++;
        }
        const total = calViol.F1 + calViol.F2 + calViol.F3 + calViol.F4;
        check(`NON-VACUOUS vs ${gen.label} (${gen.sha}): the SAME ${calDocs.length} rendered documents fail this leg, >=${gen.floor} in its OWN defect direction (${gen.want}) — ${gen.why}`,
          total > 0 && calViol[gen.want] >= gen.floor,
          { servedBytes: served, ...calViol, wantedDirection: gen.want, floor: gen.floor });
        cdp.ws.off('message', onPaused);
        await cdp.send('Fetch.disable');
      }
      // Back to the LIVE parser for everything after this point.
      await cdp.send('Page.navigate', { url: `${BASE}/` });
      await cdp.waitFor('reboot on the live parser', `!!document.querySelector('link[rel="stylesheet"]')`, 30_000);
      const restored = await cdp.eval(`(async () => {
        const t = await (await fetch('/lib/response-blocks.js')).text();
        const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
        return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
      })()`);
      check('the LIVE parser bytes are restored after the calibration (no substituted module leaked into the rest of the run)',
        restored === diskHash, { restored: restored.slice(0, 16), diskHash: diskHash.slice(0, 16) });
      // Restore EVERYTHING the earlier legs put on `window`, not just what the
      // legs after this one happen to use today. The calibration navigates the
      // page, which wipes the module map and the globals with it, and a later
      // reordering of legs must not turn that into a silent undefined.
      await cdp.eval(`(async () => {
        window.__f091 = await import('/lib/digest.js');
        window.__grammar = await import('/lib/response-blocks.js');
        window.__norm = ${NORM_SRC};
        window.__CORP = ${JSON.stringify(CORPUS.map((c) => c.text))};
        window.__FIX = ${JSON.stringify(FIXTURES)};
        if (!document.getElementById('f091-probe')) {
          const h = document.createElement('div'); h.id = 'f091-probe'; document.body.appendChild(h);
        }
        return true;
      })()`);
    }
  }

  /* ═══════ [T] THE THEME DIMENSION — is a closed fold closed in BOTH themes? ══
   * No pass has touched this. Every check in this suite, and every check in the
   * eleven independent rounds, reads STRUCTURE or the ACCESSIBILITY TREE — and a
   * CSS regression that reveals a folded body (a stray `details > * { display:
   * block }`, a theme-scoped override, a `height: auto` in one palette only) is
   * invisible to every one of them. The fold would still be `open=false`, still
   * announce `expanded=false`, still be absent from the AX tree, and the reader
   * would still be looking at the narration.
   *
   * So this leg asks the question in PIXELS, and asks it in a way that needs no
   * reference image and no human eye: render the SAME notes fold twice, closed,
   * with two bodies that share not one glyph. If the fold really hides its body,
   * the two captures are byte-identical — nothing about the body reached the
   * screen. If any of it is painted, they differ. The open capture is the
   * anti-vacuity control: it must differ, or the comparison proves nothing.
   * Height is checked too, because a body painted in the background colour would
   * pass the pixel comparison and still push the layout. Both themes are driven
   * by CDP prefers-color-scheme emulation, never localStorage. */
  console.log('\n=== [T] a closed fold is genuinely closed in BOTH themes (pixels, not structure) ===');
  {
    const foldWith = (body) => [
      '````orchard-notes',
      ...body,
      '````',
      'TAIL-AFTER-THE-FOLD',
    ].join('\n');
    const BODY_A = Array.from({ length: 30 }, (_, i) => `AAAA ${'A'.repeat(40)} ${i}`);
    const BODY_B = Array.from({ length: 30 }, (_, i) => `wwww ${'w'.repeat(40)} ${i}`);
    await cdp.eval(`window.__theme = ${JSON.stringify({ a: foldWith(BODY_A), b: foldWith(BODY_B) })}; true`);

    const themeLedger = shotLedger();
    const shoot = async (key, open, tag) => {
      const rect = await cdp.eval(`(() => {
        let host = document.getElementById('f091-theme');
        if (!host) { host = document.createElement('div'); host.id = 'f091-theme'; document.body.appendChild(host); }
        host.setAttribute('style', 'position:fixed; top:0; left:0; z-index:2147483647; box-sizing:border-box; padding:24px; background:var(--window); width:720px;');
        host.replaceChildren();
        host.appendChild(window.__f091.renderAssistantText(window.__theme[${JSON.stringify(key)}], { enabled: true, projectId: null }));
        if (${open ? 'true' : 'false'}) host.querySelectorAll('details').forEach((d) => { d.open = true; });
        const r = host.getBoundingClientRect();
        return { x: r.x, y: r.y, w: Math.ceil(r.width), h: Math.ceil(r.height) };
      })()`);
      await sleep(60);
      const shot = await cdp.send('Page.captureScreenshot', {
        format: 'png', clip: { x: rect.x, y: rect.y, width: rect.w, height: Math.max(1, rect.h), scale: 1 },
      });
      const file = path.join(SHOTS, `f091-theme-${tag}.png`);
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      return { file, h: rect.h, digest: md5(file), luma: meanLuma(file).luma };
    };

    for (const tone of ['light', 'dark']) {
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: tone }] });
      await cdp.eval(`document.documentElement.removeAttribute('data-theme'); true`);
      const a = await shoot('a', false, `${tone}-closed-a`);
      const b = await shoot('b', false, `${tone}-closed-b`);
      const o = await shoot('b', true, `${tone}-open-b`);
      check(`[${tone}] the closed fold paints NOTHING of its body: two folds with disjoint bodies are byte-identical`,
        a.digest === b.digest, { a: `${a.digest.slice(0, 8)} ${a.h}px luma=${a.luma.toFixed(1)}`, b: `${b.digest.slice(0, 8)} ${b.h}px luma=${b.luma.toFixed(1)}` });
      check(`[${tone}] ...and the closed fold does not RESERVE its body's space either (a body painted in the background colour would pass the comparison above)`,
        a.h === b.h && o.h > a.h + 40, { closed: a.h, closedB: b.h, open: o.h });
      check(`[${tone}] the comparison is not vacuous: opening the same fold DOES change the pixels`,
        o.digest !== b.digest, { open: o.digest.slice(0, 8), closed: b.digest.slice(0, 8) });
      // The tone of the capture is graded on its own pixels, not on the computed
      // styles — the failing FEAT-082 run had correct styles and wrong files.
      const graded = themeLedger.record(a.file, tone);
      check(`[${tone}] the capture really is ${tone} (mean luminance of the decoded pixels)`, graded.ok, graded.why);
      check(`[${tone}] TAIL-AFTER-THE-FOLD is on screen below the closed fold`,
        await cdp.eval(`(() => {
          const h = document.getElementById('f091-theme');
          return /TAIL-AFTER-THE-FOLD/.test(h.textContent) && h.getBoundingClientRect().height > 0;
        })()`), 'tail present');
    }
    // Cross-theme: the SAME closed fold must have the same geometry in both.
    await cdp.eval(`document.getElementById('f091-theme')?.remove(); delete window.__theme; true`);
  }

  /* ------------------------------------------------------- the visual gate */
  console.log('\n=== [V] VISUAL GATE — collapsed/expanded/free/notes-only/malformed × wide+narrow × light+dark ===');
  const ledger = shotLedger();
  const WIDTHS = [{ tag: 'wide', w: 900 }, { tag: 'narrow', w: 420 }];
  const THEMES = [{ tag: 'light', tone: 'light' }, { tag: 'dark', tone: 'dark' }];
  const SCENES = [
    { tag: 'collapsed', key: 'FULL', open: false },
    { tag: 'expanded', key: 'FULL', open: true },
    { tag: 'free', key: 'BLOCKS_FREE', open: false },
    { tag: 'notesonly', key: 'NOTES_ONLY', open: false },
    { tag: 'malformed', key: 'MALFORMED_FENCE', open: false },
    // The corrected contract, on screen: a fold AND a visible answer in one turn.
    { tag: 'localdegrade', key: 'UNTERM_THEN_VALID', open: false },
    // ROUND 12 — the semantic categories as pixels. The captions are the whole
    // reader-facing payoff, and a caption that is unreadable in one palette, or
    // that turns a reply into a wall of chrome at 420px, is invisible to the DOM
    // assertions above.
    { tag: 'semantic', key: 'SEMANTIC', open: false },
    { tag: 'legacy', key: 'LEGACY_MIX', open: false },
  ];

  for (const th of THEMES) {
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: th.tag }] });
    // Clear any app-set data-theme so the media-query tokens (not localStorage) drive the palette.
    await cdp.eval(`document.documentElement.removeAttribute('data-theme'); true`);
    for (const wd of WIDTHS) {
      for (const sc of SCENES) {
        // Lay out a fixed host of the target width, render the scene, screenshot its clip.
        const rect = await cdp.eval(`(() => {
          let host = document.getElementById('f091-shot');
          if (!host) { host = document.createElement('div'); host.id = 'f091-shot'; document.body.appendChild(host); }
          host.setAttribute('style', 'position:fixed; top:0; left:0; z-index:2147483647; box-sizing:border-box; padding:24px; background:var(--window); width:' + ${wd.w} + 'px;');
          host.replaceChildren();
          const node = window.__f091.renderAssistantText(window.__FIX[${JSON.stringify(sc.key)}], { enabled: true, projectId: null });
          host.appendChild(node);
          if (${sc.open ? 'true' : 'false'}) host.querySelectorAll('details.orchard-notes').forEach((d) => { d.open = true; });
          const r = host.getBoundingClientRect();
          return { x: r.x, y: r.y, w: Math.ceil(r.width), h: Math.ceil(r.height) };
        })()`);
        await sleep(60);
        const shot = await cdp.send('Page.captureScreenshot', {
          format: 'png',
          clip: { x: rect.x, y: rect.y, width: rect.w, height: Math.max(1, rect.h), scale: 1 },
        });
        const file = path.join(SHOTS, `f091-${sc.tag}-${wd.tag}-${th.tag}.png`);
        fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
        const res = ledger.record(file, th.tone);
        check(`shot ${sc.tag}/${wd.tag}/${th.tag} graded (${th.tone}, unique)`, res.ok, `${res.why} -> ${file}`);
      }
    }
  }

  cdp.close();
  console.log(`\nshots written to ${SHOTS}${KEEP_SHOTS ? ' (kept)' : ''}`);
  console.log(`\n${fail === 0 ? 'VERDICT: PASS' : 'VERDICT: FAIL'} — ${pass} passed, ${fail} failed`);
  if (fail) console.log('failed checks:\n  - ' + failures.join('\n  - '));
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.stack ?? err.message}`);
  process.exitCode = 1;
}).finally(() => {
  stopByPid(browser);
  stopByPid(server);
  setTimeout(() => {
    for (const d of [DATA, STORE, PROFILE, TX]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } }
    if (!KEEP_SHOTS) { try { fs.rmSync(SHOTS, { recursive: true, force: true }); } catch { /* gone */ } }
    process.exit(process.exitCode ?? 0);
  }, 1500);
});
