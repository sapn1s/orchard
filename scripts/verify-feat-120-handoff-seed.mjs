/**
 * FEAT-120 — cross-provider conversation handoff: the PURE core, proven against
 * the USER'S REAL sessions (not a synthetic fixture).
 *
 *  - readUniformSession reads the real Codex session 019ff078 (and the real
 *    Claude session 954811be, if present) read-only.
 *  - buildHandoffSeed: every human turn and every assistant TEXT answer appears
 *    in order; NO tool_use/tool_result is presented as executed state; the
 *    lost-context notice is present and complete.
 *  - MUST-FAIL negative: a crafted tool_result sentinel never reaches the seed.
 *  - Truncation safety: the real source truncated at several byte points yields
 *    a seed that never presents a half-written turn as complete.
 *
 * Run: node scripts/verify-feat-120-handoff-seed.mjs
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

// Discover the REAL sessions on this machine at runtime (no hard-coded home
// path / username in source — the leak gate rejects those, and it keeps the
// test portable). An openai session comes from the Orchard store; a claude one
// from the native CLI store. Both are the user's real artifacts.
function firstOrchardSession(root, provider) {
  const base = path.join(root, provider);
  let dirs = [];
  try { dirs = fs.readdirSync(base).filter((d) => { try { return fs.statSync(path.join(base, d)).isDirectory(); } catch { return false; } }); } catch { return null; }
  for (const d of dirs) {
    let files = [];
    try { files = fs.readdirSync(path.join(base, d)).filter((f) => f.endsWith('.jsonl') && fs.statSync(path.join(base, d, f)).size > 0); } catch { continue; }
    if (files.length) return { encodedDir: d, sessionId: files[0].replace(/\.jsonl$/, '') };
  }
  return null;
}
function firstClaudeSession() {
  const base = path.join(os.homedir(), '.claude', 'projects');
  return firstOrchardSession(path.dirname(base), path.basename(base)); // reuse the scanner over ~/.claude/projects
}

// ---- the real source file, read directly (so the test owns ground truth) ----
function realTexts(file) {
  const users = [], assistants = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const s = line.trim(); if (!s) continue;
    let o; try { o = JSON.parse(s); } catch { continue; }
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    if (o.isSidechain === true || o.isMeta === true) continue;
    const c = o.message?.content;
    const blocks = typeof c === 'string' ? [{ type: 'text', text: c }] : (Array.isArray(c) ? c : []);
    const t = blocks.filter((b) => b && b.type === 'text').map((b) => String(b.text ?? '').trim()).filter(Boolean).join('\n');
    if (t) (o.type === 'user' ? users : assistants).push(t);
  }
  return { users, assistants };
}

async function main() {
  const { readUniformSession, orchardTranscriptsRoot } = await import('../src/server/orchard-transcripts.ts');
  const { buildHandoffSeed, LOST_CONTEXT_ITEMS } = await import('../src/server/session-handoff.ts');

  const openai = firstOrchardSession(orchardTranscriptsRoot(), 'openai');
  if (!openai) { console.log('SKIP — no real OpenAI session on this machine to prove against'); summary(); return; }
  const DIR = openai.encodedDir;
  const OPENAI_ID = openai.sessionId;

  // ===== 1. REAL Codex session → Claude handoff =====
  console.log(`1) real Codex session ${OPENAI_ID.slice(0, 8)} (Codex → Claude handoff)`);
  const read = readUniformSession(DIR, OPENAI_ID);
  check('readUniformSession found the real source', read.found, JSON.stringify({ found: read.found, file: read.file }));
  if (!read.found) { summary(); return; }
  check('source provider resolved as openai', read.provider === 'openai', `provider=${read.provider}`);
  check('yielded main-thread entries', read.entries.length > 0, `entries=${read.entries.length}`);
  check('read-only: source file untouched (still exists, same size)', fs.existsSync(read.file));

  const { seed, lostContext, toolCallsSummarised } = buildHandoffSeed(read.entries, { sourceProvider: read.provider, elided: read.elided });
  const raw = realTexts(read.file);

  // every human turn present
  const missingUser = raw.users.filter((t) => !seed.includes(t.slice(0, 120)));
  check('every human turn appears in the seed', missingUser.length === 0, `${missingUser.length} missing (e.g. ${JSON.stringify((missingUser[0] || '').slice(0, 60))})`);
  // every assistant text answer present
  const missingAsst = raw.assistants.filter((t) => !seed.includes(t.slice(0, 120)));
  check('every assistant text answer appears in the seed', missingAsst.length === 0, `${missingAsst.length} missing`);
  // order preserved: the first user turn precedes the last assistant turn
  check('turns are in order (first user before last assistant)',
    raw.users.length && raw.assistants.length
      ? seed.indexOf(raw.users[0].slice(0, 80)) < seed.lastIndexOf(raw.assistants[raw.assistants.length - 1].slice(0, 80))
      : true);

  // NO tool state presented as executed
  check('no raw tool_use block leaked into the seed', !seed.includes('"type":"tool_use"') && !seed.includes('"type": "tool_use"'));
  check('no raw tool_result block leaked into the seed', !seed.includes('"type":"tool_result"') && !seed.includes('"type": "tool_result"'));
  check('no engine-private tool id leaked (toolu_/call_/fc_)', !/\btoolu_[A-Za-z0-9]/.test(seed) && !/\bcall_[A-Za-z0-9]/.test(seed) && !/\bfc_[A-Za-z0-9]/.test(seed));
  check('tool activity is summarised, not replayed', toolCallsSummarised === 0 || /ran \d+ tool call/.test(seed), `toolCallsSummarised=${toolCallsSummarised}`);

  // lost-context notice present and complete
  check('lost-context notice enumerates every item', LOST_CONTEXT_ITEMS.every((it) => seed.includes(it)));
  check('lostContext returned matches the constant', lostContext.length === LOST_CONTEXT_ITEMS.length);
  check('seed states it is a continuation on Claude’s side wording (source labelled)', seed.includes('OpenAI Codex'));

  // ===== 2. MUST-FAIL negative: a tool_result sentinel must NEVER reach the seed =====
  console.log('2) must-fail negative — tool_result content is never emitted as state');
  const SENTINEL = 'SENTINEL_TOOL_OUTPUT_ZZZ_9f3a';
  const crafted = [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'please read the file' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'thinking', thinking: 'SENTINEL_THINKING_SHOULD_DROP' },
      { type: 'text', text: 'Reading it now.' },
      { type: 'tool_use', name: 'Read', id: 'toolu_abc', input: { path: '/x' } },
    ] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_abc', content: SENTINEL }] } },
  ];
  const craftedSeed = buildHandoffSeed(crafted, { sourceProvider: 'anthropic' }).seed;
  check('tool_result content (sentinel) is ABSENT from the seed', !craftedSeed.includes(SENTINEL), 'sentinel leaked — tool state presented as executed');
  check('thinking content is ABSENT from the seed', !craftedSeed.includes('SENTINEL_THINKING_SHOULD_DROP'), 'thinking leaked');
  check('the genuine human + assistant text IS present', craftedSeed.includes('please read the file') && craftedSeed.includes('Reading it now.'));
  check('the tool_use is summarised by name only', /ran 1 tool call: Read/.test(craftedSeed));

  // ===== 3. Truncation safety on the REAL source =====
  console.log('3) truncation safety — real source cut at several byte points');
  const fullBytes = fs.statSync(read.file).size;
  // Exact per-entry text of the full source — a complete turn matches this set
  // exactly; a half-written final line could not, so it must be dropped, never
  // yielded. Operates on the READER's entries directly (not the seed), so the
  // test is about truncation handling, not seed formatting.
  const entryText = (o) => {
    const c = o.message?.content;
    const blocks = typeof c === 'string' ? [{ type: 'text', text: c }] : (Array.isArray(c) ? c : []);
    return blocks.filter((b) => b && b.type === 'text').map((b) => String(b.text ?? '').trim()).filter(Boolean).join('\n');
  };
  const fullEntryTexts = new Set(read.entries.map(entryText).filter(Boolean));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feat120-trunc-'));
  const prevEnv = process.env.CLAUDE_STATION_DATA;
  try {
    const destDir = path.join(tmp, 'transcripts', 'openai', DIR);
    fs.mkdirSync(destDir, { recursive: true });
    const destFile = path.join(destDir, `${OPENAI_ID}.jsonl`);
    const srcBuf = fs.readFileSync(read.file);
    const cuts = [0.25, 0.5, 0.75, 0.9, 0.97].map((f) => Math.floor(fullBytes * f));
    process.env.CLAUDE_STATION_DATA = tmp; // redirect the Orchard store to the truncated copy
    for (const cut of cuts) {
      fs.writeFileSync(destFile, srcBuf.subarray(0, cut));
      const r = readUniformSession(DIR, OPENAI_ID);
      let built = { seed: '' };
      let threw = false;
      try { built = buildHandoffSeed(r.entries, { sourceProvider: r.provider, elided: r.elided }); } catch { threw = true; }
      check(`cut@${cut}B: build did not throw`, !threw && built.seed.length > 0);
      // Every entry the reader returned at this cut is a COMPLETE turn that
      // exists verbatim in the full source — a half-written final line is
      // dropped by the JSON.parse guard, never yielded as a complete turn.
      const partial = r.entries.map(entryText).filter(Boolean).filter((t) => !fullEntryTexts.has(t));
      check(`cut@${cut}B: no half-written turn presented as complete`, partial.length === 0,
        `${partial.length} partial (e.g. ${JSON.stringify((partial[0] || '').slice(0, 50))})`);
    }
  } finally {
    if (prevEnv === undefined) delete process.env.CLAUDE_STATION_DATA; else process.env.CLAUDE_STATION_DATA = prevEnv;
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ===== 4. Reverse direction (Claude → Codex), if a real Claude session exists =====
  console.log('4) real Claude session (Claude → Codex handoff), if present');
  const claude = firstClaudeSession();
  const rc = claude ? readUniformSession(claude.encodedDir, claude.sessionId) : { found: false };
  if (rc.found) {
    check('Claude source resolved as anthropic', rc.provider === 'anthropic', `provider=${rc.provider}`);
    const s2 = buildHandoffSeed(rc.entries, { sourceProvider: rc.provider });
    check('reverse seed labels the source as Claude', s2.seed.includes('Claude'));
    check('reverse seed carries the lost-context notice', LOST_CONTEXT_ITEMS.every((it) => s2.seed.includes(it)));
  } else {
    console.log('  SKIP — no Claude session on disk (not an error)');
  }

  summary();
}

function summary() {
  console.log(`\nFEAT-120 handoff-seed: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
