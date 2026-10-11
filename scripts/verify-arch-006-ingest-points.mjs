/**
 * ARCH-006 (option A) — canonicalize line endings at the LAST two server ingest
 * points the migration had not yet converted:
 *
 *   1. src/server/orchard-transcripts.ts — the TRANSCRIPT ingest. `recordUserPrompt`
 *      and `recordRuntimeMessage` wrote the text a session produces into the
 *      append-only `.jsonl` with NO CR handling, so a lone/bare `\r` survived into
 *      the transcript file every renderer later reads.
 *   2. src/server/index.ts (readGuidePage, ~:289) — the GUIDE FILE ingest. It read
 *      guide markdown with `/\r\n/g` (CRLF only), so a lone CR survived into the
 *      guide renderer.
 *
 *   npx tsx scripts/verify-arch-006-ingest-points.mjs
 *
 * PART 0  must-FAIL non-vacuity (git-independent, SYNTHESIZED pre-fix state, not a
 *         moving baseline): the transcript pre-fix wrote text verbatim (no CR rule)
 *         and the guide pre-fix used `/\r\n/g`; both leave a lone CR. The shared
 *         `normalizeLineEndings` removes it.
 * PART A  REAL TranscriptRecorder over a scratch data dir (CLAUDE_STATION_DATA):
 *         record a user prompt and a runtime assistant message whose renderable
 *         prose is separated by LF, CRLF and a LONE CR; re-read the written .jsonl
 *         and assert NO embedded CR survives in any text/thinking field and every
 *         paragraph is on its own line. Pre-fix a lone-CR paragraph is swallowed.
 * PART B  REAL guide-file ingest: write a REAL guide .md on disk with CRLF + lone-CR
 *         frontmatter and body, run the EXACT expression readGuidePage now uses
 *         (`board.normalizeLineEndings(fs.readFileSync(...))`), and assert the body
 *         is CR-free and the frontmatter pin is stripped. The pre-fix `/\r\n/g`
 *         leaves the lone CR (and fails to strip a lone-CR-terminated frontmatter).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

// Isolate the data dir BEFORE importing anything that resolves it (orchard-transcripts
// reads dataDir() at call time, but set it first regardless so no real dir is touched).
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'arch006-ingest-'));
process.env.CLAUDE_STATION_DATA = SCRATCH;

const { normalizeLineEndings } = await import('../src/server/board.ts');
const { TranscriptRecorder } = await import('../src/server/orchard-transcripts.ts');

let pass = 0, fail = 0;
const failures = [];
const show = (s) => JSON.stringify(String(s)).replace(/\\r/g, '<CR>').replace(/\\n/g, '<LF>');
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}

// A realistic multi-paragraph body as a model/user might emit it: mixed endings,
// with paragraph 3 separated by a LONE CR — the case the pre-fix code never handled.
const P1 = 'First paragraph, ordinary LF text.';
const P2 = 'Second paragraph, arrived via CRLF (Windows paste).';
const P3 = 'Third paragraph, arrived via a LONE CR — this is the one that vanishes.';
const P4 = 'Fourth paragraph, plain LF again.';
const BODY = `${P1}\n${P2}\r\n${P3}\r${P4}`;
const PARTS = [P1, P2, P3, P4];

/* ── PART 0 — must-FAIL non-vacuity, synthesized pre-fix states ───────────── */
function part0() {
  console.log('\n=== PART 0 — must-FAIL: both pre-fix rules leave a lone CR; the shared normaliser removes it ===');
  const transcriptPrefix = (t) => String(t ?? '');            // transcript ingest OLD rule: verbatim, no CR handling
  const guidePrefix = (t) => String(t ?? '').replace(/\r\n/g, '\n'); // guide ingest OLD rule: CRLF only
  const shared = (t) => normalizeLineEndings(t);              // the ONE real normaliser both now use

  check('MUST-FAIL: transcript pre-fix (verbatim) leaves a lone CR embedded',
    /\r/.test(transcriptPrefix(BODY)) === true, show(transcriptPrefix(BODY)));
  check('MUST-FAIL: guide pre-fix (\\r\\n only) leaves a lone CR embedded',
    /\r/.test(guidePrefix(BODY)) === true, show(guidePrefix(BODY)));
  check('FIXED: the shared normaliser leaves no CR', /\r/.test(shared(BODY)) === false, show(shared(BODY)));
  const lines = shared(BODY).split('\n');
  check('shared normaliser splits the body into exactly 4 lines (CRLF+CR+LF all become LF)',
    lines.length === 4 && PARTS.every((p, i) => lines[i] === p), show(shared(BODY)));
}

/* ── PART A — REAL TranscriptRecorder write path over a scratch data dir ───── */
function partA() {
  console.log('\n=== PART A — REAL TranscriptRecorder: a lone CR in recorded prose must not reach the .jsonl ===');
  const rec = new TranscriptRecorder({ provider: 'anthropic', cwd: '/tmp/arch006-proj', encodedDir: 'arch006-proj' });
  rec.adoptSessionId('arch006-session');
  const file = rec.filePath;
  check('recorder named a file under the scratch data dir', !!file && file.startsWith(SCRATCH), String(file));

  // A user prompt and an assistant message, both carrying the mixed-ending body.
  rec.recordUserPrompt(BODY);
  rec.recordRuntimeMessage({
    type: 'assistant',
    message: { content: [
      { type: 'text', text: BODY },
      { type: 'thinking', thinking: `Reasoning line one.\r${P4}` },
      { type: 'tool_use', id: 'tu1', name: 'x', input: { note: `keep this CR\rverbatim` } }, // non-prose: untouched
    ] },
  });

  const raw = fs.readFileSync(file, 'utf8');
  const entries = raw.trim().split('\n').map((l) => JSON.parse(l));
  check('two entries were written (user prompt + assistant message)', entries.length === 2, entries.length);

  // Collect every renderable prose string across both entries.
  const proseStrings = [];
  for (const e of entries) {
    for (const b of (e.message?.content ?? [])) {
      if (typeof b.text === 'string') proseStrings.push(b.text);
      if (typeof b.thinking === 'string') proseStrings.push(b.thinking);
    }
  }
  check('no renderable prose field in the written transcript contains a CR',
    proseStrings.every((s) => !/\r/.test(s)) && proseStrings.length >= 3, proseStrings.map(show));

  // The user prompt text must preserve all four paragraphs on their own lines.
  const userText = entries[0].message.content[0].text;
  const userLines = userText.split('\n');
  check('user-prompt prose keeps all 4 paragraphs on their own lines (lone-CR paragraph survives)',
    userLines.length === 4 && PARTS.every((p, i) => userLines[i] === p), show(userText));

  // Non-prose fields (tool input) are left byte-identical — the CR there is NOT prose.
  const toolBlock = entries[1].message.content.find((b) => b.type === 'tool_use');
  check('non-prose tool_use input is left byte-identical (CR preserved, not a renderer boundary)',
    toolBlock && /\r/.test(toolBlock.input.note), show(toolBlock?.input?.note));
}

/* ── PART B — REAL guide-file ingest (the exact expression readGuidePage runs) ─ */
function partB() {
  console.log('\n=== PART B — REAL guide .md on disk: readGuidePage ingest must canonicalize a lone CR ===');
  const gdir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch006-guide-'));
  const gfile = path.join(gdir, 'page.md');
  // Frontmatter block whose closing fence is terminated by a LONE CR, then a body
  // whose paragraphs are separated by CRLF and a lone CR. Written as REAL bytes.
  const contents = `---\rsources:\r  - x\r---\r# Title\r\n${P1}\r\n${P2}\r${P3}\n${P4}`;
  fs.writeFileSync(gfile, contents);

  // The EXACT ingest expression readGuidePage now uses (src/server/index.ts ~:289).
  const rawPost = normalizeLineEndings(fs.readFileSync(gfile, 'utf8'));
  // The pre-fix expression for contrast.
  const rawPre = fs.readFileSync(gfile, 'utf8').replace(/\r\n/g, '\n');

  check('MUST-FAIL: pre-fix guide read (\\r\\n only) leaves a lone CR in the raw guide text',
    /\r/.test(rawPre) === true, show(rawPre));
  check('FIXED: post-fix guide read is CR-free', /\r/.test(rawPost) === false, show(rawPost));

  // readGuidePage then strips a leading frontmatter block with `/^---\n[\s\S]*?\n---\n?/`.
  const fmRe = /^---\n[\s\S]*?\n---\n?/;
  check('MUST-FAIL: frontmatter pin is NOT stripped from the pre-fix (lone-CR) guide text',
    fmRe.test(rawPre) === false, show(rawPre.slice(0, 40)));
  const bodyPost = fmRe.test(rawPost) ? rawPost.replace(fmRe, '') : rawPost;
  check('FIXED: frontmatter pin IS stripped from the canonical guide text', fmRe.test(rawPost) === true, show(rawPost.slice(0, 40)));
  check('FIXED: canonical guide body starts at the title, pin removed', bodyPost.startsWith('# Title'), show(bodyPost.slice(0, 30)));

  fs.rmSync(gdir, { recursive: true, force: true });
}

try {
  part0();
  partA();
  partB();
} finally {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
if (fail) { console.log('failed:', failures.join('; ')); process.exit(1); }
