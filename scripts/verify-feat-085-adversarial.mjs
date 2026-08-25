#!/usr/bin/env node
/**
 * FEAT-085 — INDEPENDENT ADVERSARIAL verification of the Stop-hook response-format gate.
 *
 * Written from scratch by a clean-room verifier who did NOT author the hook and did
 * NOT read the builder's verify script. Sole objective: try to make the live hook
 *   (scripts/hooks/response-format-gate.mjs)
 * WEDGE a turn — i.e. BLOCK when it must ALLOW, HANG past its watchdog, crash, or
 * emit stdout the harness would mis-read as a block. A faulty Stop hook can brick
 * every reply in the user's session, so that failure mode outranks everything.
 *
 * Classification of an observed run (mirrors how Claude Code reads a Stop hook):
 *   ALLOW  = exit 0 AND stdout has no {"decision":"block"} (empty, or approve).
 *   BLOCK  = stdout parses to JSON with decision === "block".
 *   WEDGE  = a BLOCK we asserted should be an ALLOW  (HARD FAIL — can brick a turn).
 *   HANG   = process still alive past a hard 6s cap (> 3s watchdog, > 5s hook timeout).
 *   CRASH  = non-zero exit, or stdout that is neither empty nor valid JSON.
 *
 * We drive the REAL hook as a subprocess with hostile stdin + synthetic/real
 * transcripts. We never loosen the grammar; every "must BLOCK" case is asserted too,
 * so a permissive regression is caught as well.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const HOOK = path.join(ROOT, 'scripts', 'hooks', 'response-format-gate.mjs');
const HARD_CAP_MS = 6000; // beyond the hook's 3s watchdog and the settings.json 5s timeout

let pass = 0, fail = 0;
const failures = [];
const warnings = [];
function ok(name) { pass++; /* console.log('  ok   ' + name); */ }
function bad(name, detail) { fail++; failures.push(name + ' — ' + detail); console.log('  FAIL ' + name + ' — ' + detail); }
function warn(name, detail) { warnings.push(name + ' — ' + detail); console.log('  WARN ' + name + ' — ' + detail); }

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

/** Run the hook once. Returns {timedOut, code, signal, stdout, stderr, ms}. */
function runHook(stdinStr, env = {}) {
  const own = ownRaw(stdinStr);
  stdinStr = own.input;
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [HOOK], {
      env: { ...process.env, ORCHARD_SESSION: own.marker, ORCHARD_STOP_HOOK_ENFORCE: "1", ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch {}
      resolve({ timedOut: true, code: null, signal: 'SIGKILL', stdout, stderr, ms: Date.now() - started });
    }, HARD_CAP_MS);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => {
      if (done) return; done = true; clearTimeout(timer);
      resolve({ timedOut: false, code: -1, signal: null, stdout, stderr: stderr + '\nSPAWN_ERR:' + e.message, ms: Date.now() - started });
    });
    child.on('close', (code, signal) => {
      if (done) return; done = true; clearTimeout(timer);
      resolve({ timedOut: false, code, signal, stdout, stderr, ms: Date.now() - started });
    });
    try { child.stdin.write(stdinStr); child.stdin.end(); } catch {}
  });
}

/** Classify a run into ALLOW / BLOCK / CRASH / HANG. */
function classify(r) {
  if (r.timedOut) return { verdict: 'HANG', reason: `alive > ${HARD_CAP_MS}ms` };
  if (r.code !== 0) return { verdict: 'CRASH', reason: `exit code ${r.code} signal ${r.signal}` };
  const s = r.stdout.trim();
  if (s === '') return { verdict: 'ALLOW', reason: 'empty stdout' };
  let j;
  try { j = JSON.parse(s); } catch { return { verdict: 'CRASH', reason: 'stdout not empty and not JSON: ' + s.slice(0, 120) }; }
  if (j && j.decision === 'block') return { verdict: 'BLOCK', reason: 'decision:block' };
  if (j && j.decision === 'approve') return { verdict: 'ALLOW', reason: 'decision:approve' };
  return { verdict: 'ALLOW', reason: 'json without block' };
}

/** Assert a run's verdict. `want` in {ALLOW, BLOCK}. HANG/CRASH always fail. */
async function expect(name, stdinStr, want, env = {}) {
  const r = await runHook(stdinStr, env);
  const c = classify(r);
  if (c.verdict === 'HANG') { bad(name, `HANG (${c.reason}) [${r.ms}ms] — could stall every turn`); return r; }
  if (c.verdict === 'CRASH') { bad(name, `CRASH (${c.reason}) [${r.ms}ms] stderr=${r.stderr.slice(0,200)}`); return r; }
  if (c.verdict !== want) {
    const sev = (want === 'ALLOW' && c.verdict === 'BLOCK') ? 'WEDGE — blocks a turn that must be allowed' : 'wrong verdict';
    bad(name, `${sev}: got ${c.verdict}, want ${want} [${r.ms}ms]`);
    return r;
  }
  ok(name + ` (${c.verdict}, ${r.ms}ms)`);
  return r;
}

/* ── transcript helpers ─────────────────────────────────────────────────── */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'feat085-adv-'));
const cleanup = [];
function tmpFile(name, content) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, content);
  return p;
}
function jsonl(lines) { return lines.map((o) => (typeof o === 'string' ? o : JSON.stringify(o))).join('\n') + '\n'; }
function asst(text, extra = {}) {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, ...extra };
}
function payload(transcriptPath, extra = {}) {
  return JSON.stringify({ session_id: 's', transcript_path: transcriptPath, cwd: TMP, hook_event_name: 'Stop', stop_hook_active: false, ...extra });
}

const GOOD_DIGEST = '```orchard-digest\n{"items":[{"text":"Did the thing","kind":"done","importance":"high"}]}\n```\n\nSome prose below.';

async function main() {
  console.log('FEAT-085 adversarial verify — hook:', HOOK);

  /* ── A. Malformed / hostile stdin — MUST fail open (ALLOW) ─────────────── */
  await expect('A1 empty stdin', '', 'ALLOW');
  await expect('A2 whitespace-only stdin', '   \n\t  ', 'ALLOW');
  await expect('A3 garbage non-JSON', '}{ this is not json at all', 'ALLOW');
  await expect('A4 truncated JSON', '{"transcript_path":', 'ALLOW');
  await expect('A5 JSON number (not object)', '12345', 'ALLOW');
  await expect('A6 JSON string (not object)', '"hello"', 'ALLOW');
  await expect('A7 JSON null', 'null', 'ALLOW');
  await expect('A8 JSON true', 'true', 'ALLOW');
  await expect('A9 JSON array', '[1,2,3]', 'ALLOW');
  await expect('A10 empty object', '{}', 'ALLOW');
  await expect('A11 huge junk stdin (2MB)', '{' + 'x'.repeat(2_000_000), 'ALLOW');

  /* ── B. Loop-cap: stop_hook_active — the wedge-prevention core ─────────── */
  const noDigest = tmpFile('nodigest.jsonl', jsonl([asst('Just plain prose, no digest here at all.')]));
  await expect('B1 stop_hook_active:true + non-compliant -> ALLOW (loop cap)', payload(noDigest, { stop_hook_active: true }), 'ALLOW');
  // Non-boolean truthy variants: documents whether the loop cap is brittle.
  await expect('B2 stop_hook_active:1 (number)  [probe]', payload(noDigest, { stop_hook_active: 1 }), 'BLOCK');
  await expect('B3 stop_hook_active:"true" (str) [probe]', payload(noDigest, { stop_hook_active: 'true' }), 'BLOCK');
  await expect('B4 stop_hook_active:"false"(str) [probe]', payload(noDigest, { stop_hook_active: 'false' }), 'BLOCK');
  await expect('B5 stop_hook_active missing -> grades (BLOCK on non-compliant)', payload(noDigest, { stop_hook_active: undefined }), 'BLOCK');
  await expect('B6 stop_hook_active:null -> grades (BLOCK on non-compliant)', payload(noDigest, { stop_hook_active: null }), 'BLOCK');
  // The important safety direction: even if it blocks once, a compliant re-send is always allowed.
  const good = tmpFile('good.jsonl', jsonl([asst(GOOD_DIGEST)]));
  await expect('B7 stop_hook_active:true + COMPLIANT -> ALLOW', payload(good, { stop_hook_active: true }), 'ALLOW');

  /* ── C. Transcript read failures — MUST fail open (ALLOW) ─────────────── */
  await expect('C1 missing transcript_path key', JSON.stringify({ cwd: TMP, hook_event_name: 'Stop' }), 'ALLOW');
  await expect('C2 transcript_path not a string', payload(0).replace('"transcript_path":"0"', '"transcript_path":12'), 'ALLOW');
  await expect('C3 transcript_path nonexistent file', payload(path.join(TMP, 'nope-does-not-exist.jsonl')), 'ALLOW');
  const dirPath = path.join(TMP, 'iamadir'); fs.mkdirSync(dirPath);
  await expect('C4 transcript_path is a directory (EISDIR)', payload(dirPath), 'ALLOW');
  // symlink loop
  const loopA = path.join(TMP, 'loopA'), loopB = path.join(TMP, 'loopB');
  try { fs.symlinkSync(loopB, loopA); fs.symlinkSync(loopA, loopB); await expect('C5 transcript_path symlink loop (ELOOP)', payload(loopA), 'ALLOW'); }
  catch (e) { ok('C5 symlink loop skipped (' + e.code + ')'); }
  // unreadable file (chmod 000)
  const noread = tmpFile('noread.jsonl', jsonl([asst('plain prose no digest')]));
  try {
    fs.chmodSync(noread, 0o000); cleanup.push(() => { try { fs.chmodSync(noread, 0o600); } catch {} });
    if (process.getuid && process.getuid() === 0) { ok('C6 unreadable skipped (running as root)'); }
    else await expect('C6 transcript_path EACCES (no read perm)', payload(noread), 'ALLOW');
  } catch (e) { ok('C6 unreadable setup skipped (' + e.message + ')'); }
  // empty transcript file
  await expect('C7 empty transcript file', payload(tmpFile('empty.jsonl', '')), 'ALLOW');
  // transcript with only blank + corrupt lines
  await expect('C8 all-garbage JSONL lines', payload(tmpFile('garbage.jsonl', 'not json\n\n{broken\n   \n}}}}\n')), 'ALLOW');

  /* ── D. Transcript SEMANTICS — final main-thread text selection ────────── */
  // No assistant turn at all -> allow
  await expect('D1 transcript with no assistant turn', payload(tmpFile('nouser.jsonl', jsonl([{ type: 'user', message: { role: 'user', content: 'hi' } }]))), 'ALLOW');
  // Sidechain-only assistant turns (subagents) -> ignored -> allow
  await expect('D2 sidechain-only assistant (isSidechain:true)', payload(tmpFile('side.jsonl', jsonl([
    asst('SUBAGENT non-compliant reply with no digest', { isSidechain: true }),
    asst('ANOTHER subagent turn also non-compliant', { isSidechain: true }),
  ]))), 'ALLOW');
  // Final MAIN-thread text AFTER sidechain entries: must grade the main-thread one.
  await expect('D3 main-thread non-compliant AFTER sidechain -> BLOCK the main turn', payload(tmpFile('mixside.jsonl', jsonl([
    asst(GOOD_DIGEST, { isSidechain: true }),                 // subagent WAS compliant — must be ignored
    asst('Main thread final: plain prose, no digest.'),       // real final -> non-compliant
  ]))), 'BLOCK');
  // Compliant main-thread final AFTER a non-compliant sidechain -> ALLOW (no false wedge)
  await expect('D4 compliant main-thread AFTER non-compliant sidechain -> ALLOW', payload(tmpFile('mixside2.jsonl', jsonl([
    asst('subagent junk no digest', { isSidechain: true }),
    asst(GOOD_DIGEST),
  ]))), 'ALLOW');
  // Final assistant is tool_use only (no text block) -> nothing to check -> allow
  await expect('D5 final assistant tool_use only (no text)', payload(tmpFile('toolonly.jsonl', jsonl([
    asst(GOOD_DIGEST),
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] } },
  ]))), 'ALLOW');
  // content is a plain STRING, not an array -> skipped -> falls through to allow
  await expect('D6 assistant content is a string not array', payload(tmpFile('strcontent.jsonl', jsonl([
    { type: 'assistant', message: { role: 'assistant', content: 'plain string reply no digest' } },
  ]))), 'ALLOW');
  // multiple text blocks concatenated, leading with digest across split -> ALLOW
  await expect('D7 multiple text blocks (digest + prose split) compliant', payload(tmpFile('multi.jsonl', JSON.stringify({
    type: 'assistant', message: { role: 'assistant', content: [
      { type: 'text', text: '```orchard-digest\n{"items":[{"text":"a","kind":"fyi"}]}\n```\n' },
      { type: 'text', text: 'trailing prose in a second block' },
    ] } }) + '\n')), 'ALLOW');
  // trailing/blank/partial lines around a valid last entry
  await expect('D8 valid entry then trailing blank/partial lines', payload(tmpFile('trailing.jsonl',
    jsonl([asst('plain no digest')]) + '\n\n   \n{partial broken line')), 'BLOCK');
  // D9 — the LIVE false-block shape: ONE logical message (one message.id) split
  // across MULTIPLE JSONL lines (thinking line, then digest line, then prose
  // line). Grading only the trailing line saw no fence and falsely blocked; the
  // grader must concatenate the whole message -> ALLOW.
  const splitId = 'msg_SPLIT_D9';
  const splitLine = (content) => JSON.stringify({ type: 'assistant', message: { id: splitId, role: 'assistant', content } });
  await expect('D9 logical message split across JSONL lines (digest+prose, same id) -> ALLOW', payload(tmpFile('splitmsg.jsonl',
    [
      splitLine([{ type: 'thinking', thinking: '', signature: 's' }]),
      splitLine([{ type: 'text', text: '```orchard-digest\n{"items":[{"text":"Did the thing — reviewer is right","kind":"done","importance":"high"}]}\n```' }]),
      splitLine([{ type: 'text', text: '\n\nTrailing prose on a later JSONL line, no fence here.' }]),
    ].join('\n') + '\n')), 'ALLOW');
  // D10 — over-permissiveness guard: a split message with NO digest on any of its
  // lines must still BLOCK (concatenation must not manufacture a pass).
  await expect('D10 split message, all-prose lines (same id), no digest -> BLOCK', payload(tmpFile('splitnc.jsonl',
    [
      splitLine([{ type: 'thinking', thinking: '', signature: 's' }]),
      splitLine([{ type: 'text', text: 'First prose line.' }]),
      splitLine([{ type: 'text', text: ' Second prose line, still no digest.' }]),
    ].join('\n') + '\n')), 'BLOCK');
  // D11 — a PRIOR compliant turn (different id) must NOT be merged in to rescue a
  // later non-compliant turn.
  await expect('D11 different-id neighbour not merged (prior compliant does not rescue) -> BLOCK', payload(tmpFile('twoids.jsonl',
    jsonl([
      { type: 'assistant', message: { id: 'msg_prev', role: 'assistant', content: [{ type: 'text', text: GOOD_DIGEST }] } },
      { type: 'assistant', message: { id: 'msg_next', role: 'assistant', content: [{ type: 'text', text: 'a whole new turn with no digest' }] } },
    ]))), 'BLOCK');

  /* ── E. Emoji false-positive hunt (legitimate chars must NOT block) ────── */
  const legitChars = 'Arrows → ← ⇒ ↔ ⇔ ↑ ↓ ↕. Dashes — – ‒. Marks ™ © ®. Box ─│┌┐└┘├┤┼. Checks ✓ ✗ ✔ ✘. Math ∑ ∫ ≤ ≥ ≠ ≈ ± × ÷ ∞ √ ∂ ∇. Greek αβγδ Ω π λ. CJK 日本語 中文 한국어. Accents café naïve résumé Zürich. Currency € £ ¥ ₹ ¢ ₽. Bullets • ◦ ▪ ‣ ·. Quotes “ ” ‘ ’ « ». Ellipsis … dagger † ‡. Stars ★ ☆ ⋆. Frac ½ ¼ ¾. Super x² y³. Warn ⚠ (no vs16). Info ℹ (no vs16).';
  const compliantWithLegit = '```orchard-digest\n{"items":[{"text":"Uses → arrows and — dashes and ✓ checks","kind":"decision","importance":"high"}]}\n```\n\n' + legitChars;
  await expect('E1 compliant reply full of legit typographic chars -> ALLOW (no emoji false-positive)', payload(tmpFile('legit.jsonl', jsonl([asst(compliantWithLegit)])), {}), 'ALLOW');
  // Real emoji in an OTHERWISE compliant reply -> must BLOCK (true positive)
  await expect('E2 compliant digest but emoji 🎉 in prose -> BLOCK', payload(tmpFile('emoji.jsonl', jsonl([asst('```orchard-digest\n{"items":[{"text":"x","kind":"done"}]}\n```\n\nDone 🎉 great')]))), 'BLOCK');
  await expect('E3 VS16-forced pictograph ⚠️ -> BLOCK (emoji presentation)', payload(tmpFile('vs16.jsonl', jsonl([asst('```orchard-digest\n{"items":[{"text":"x","kind":"fyi"}]}\n```\nwarn ⚠️')]))), 'BLOCK');

  /* ── F. Compliant-shape edge cases — MUST ALLOW (no false wedge) ───────── */
  await expect('F1 leading blank lines before fence', payload(tmpFile('lead.jsonl', jsonl([asst('\n\n\n' + GOOD_DIGEST)]))), 'ALLOW');
  await expect('F2 CRLF line endings', payload(tmpFile('crlf.jsonl', jsonl([asst('```orchard-digest\r\n{"items":[{"text":"a","kind":"done"}]}\r\n```\r\n\r\nprose')]))), 'ALLOW');
  await expect('F3 four-backtick fence', payload(tmpFile('four.jsonl', jsonl([asst('````orchard-digest\n{"items":[{"text":"a","kind":"fyi"}]}\n````\nprose')]))), 'ALLOW');
  await expect('F4 unicode in item text', payload(tmpFile('uni.jsonl', jsonl([asst('```orchard-digest\n{"items":[{"text":"日本語 café → done","kind":"done"}]}\n```')]))), 'ALLOW');
  const bigItems = { items: Array.from({ length: 500 }, (_, i) => ({ text: 'item ' + i, kind: 'fyi', importance: 'low' })) };
  await expect('F5 very large digest (500 items)', payload(tmpFile('bigd.jsonl', jsonl([asst('```orchard-digest\n' + JSON.stringify(bigItems) + '\n```\nprose')]))), 'ALLOW');
  await expect('F6 digest followed by huge prose (1MB)', payload(tmpFile('bigp.jsonl', jsonl([asst('```orchard-digest\n{"items":[{"text":"a","kind":"done"}]}\n```\n\n' + 'lorem ipsum dolor sit amet. '.repeat(40000))]))), 'ALLOW');

  /* ── G. Correct BLOCK cases (must not go permissive) ───────────────────── */
  await expect('G1 no digest, plain prose -> BLOCK', payload(tmpFile('g1.jsonl', jsonl([asst('Here is a perfectly ordinary long answer with no digest block.')]))), 'BLOCK');
  await expect('G2 fence present, malformed JSON -> BLOCK', payload(tmpFile('g2.jsonl', jsonl([asst('```orchard-digest\n{items: not valid json,,}\n```\nprose')]))), 'BLOCK');
  await expect('G3 fence present, empty items -> BLOCK', payload(tmpFile('g3.jsonl', jsonl([asst('```orchard-digest\n{"items":[]}\n```\nprose')]))), 'BLOCK');
  await expect('G4 items present but all blank text -> BLOCK', payload(tmpFile('g4.jsonl', jsonl([asst('```orchard-digest\n{"items":[{"text":"   ","kind":"done"}]}\n```\nprose')]))), 'BLOCK');
  await expect('G5 digest NOT at top (prose first) -> BLOCK', payload(tmpFile('g5.jsonl', jsonl([asst('Intro line first.\n```orchard-digest\n{"items":[{"text":"a","kind":"done"}]}\n```')]))), 'BLOCK');

  /* ── H. Disable switch + per-project opt-out ───────────────────────────── */
  await expect('H1 ORCHARD_STOP_HOOK_DISABLED=1 + non-compliant -> ALLOW', payload(noDigest), 'ALLOW', { ORCHARD_STOP_HOOK_DISABLED: '1' });
  await expect('H2 disabled=true -> ALLOW', payload(noDigest), 'ALLOW', { ORCHARD_STOP_HOOK_DISABLED: 'true' });
  await expect('H3 disabled=yes -> ALLOW', payload(noDigest), 'ALLOW', { ORCHARD_STOP_HOOK_DISABLED: 'yes' });
  await expect('H4 disabled=0 -> NOT disabled -> BLOCK', payload(noDigest), 'BLOCK', { ORCHARD_STOP_HOOK_DISABLED: '0' });
  await expect('H5 disabled=false -> NOT disabled -> BLOCK', payload(noDigest), 'BLOCK', { ORCHARD_STOP_HOOK_DISABLED: 'false' });
  await expect('H6 disabled="" -> NOT disabled -> BLOCK', payload(noDigest), 'BLOCK', { ORCHARD_STOP_HOOK_DISABLED: '' });

  // Registry-driven per-project opt-out. Point CLAUDE_STATION_DATA at a scratch registry.
  const regDir = path.join(TMP, 'regdata'); fs.mkdirSync(regDir);
  const projCwd = path.join(TMP, 'optoutproj'); fs.mkdirSync(projCwd);
  const noDigestInProj = payload(noDigest, {}); // uses cwd:TMP; override cwd below
  const optoutPayload = JSON.stringify({ session_id: 's', transcript_path: noDigest, cwd: projCwd, hook_event_name: 'Stop', stop_hook_active: false });
  // registry that DISABLES the digest for projCwd
  fs.writeFileSync(path.join(regDir, 'registry.json'), JSON.stringify({ projects: [{ hostPath: projCwd, settings: { responseDigest: { enabled: false } } }] }));
  await expect('H7 registry responseDigest.enabled=false for cwd -> ALLOW', optoutPayload, 'ALLOW', { CLAUDE_STATION_DATA: regDir });
  // registry that ENABLES (enabled true) -> still grades -> BLOCK non-compliant
  fs.writeFileSync(path.join(regDir, 'registry.json'), JSON.stringify({ projects: [{ hostPath: projCwd, settings: { responseDigest: { enabled: true } } }] }));
  await expect('H8 registry enabled=true for cwd -> BLOCK non-compliant', optoutPayload, 'BLOCK', { CLAUDE_STATION_DATA: regDir });
  // corrupt registry -> best-effort, must NOT crash -> grades -> BLOCK
  fs.writeFileSync(path.join(regDir, 'registry.json'), '{ this is : not json ]');
  await expect('H9 corrupt registry -> fail-soft, grades -> BLOCK', optoutPayload, 'BLOCK', { CLAUDE_STATION_DATA: regDir });
  // missing registry dir -> must not crash -> grades -> BLOCK
  await expect('H10 missing registry -> fail-soft, grades -> BLOCK', optoutPayload, 'BLOCK', { CLAUDE_STATION_DATA: path.join(TMP, 'no-such-dir') });

  /* ── I. Real large transcripts (perf within watchdog) ──────────────────── */
  // Claude Code encodes a project's cwd into its transcript dir name by turning
  // every path separator into a dash. Derive it from ROOT so no absolute path /
  // username is hardcoded (keeps the public leak-gate clean).
  const realDir = path.join(os.homedir(), '.claude', 'projects', ROOT.replace(/\//g, '-'));
  try {
    const files = fs.readdirSync(realDir).filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f, s: fs.statSync(path.join(realDir, f)).size })).sort((a, b) => b.s - a.s);
    if (files.length) {
      // Grade a stable COPY, not the live file. The biggest transcript is very
      // often THIS session's, still being appended to; its final main-thread
      // assistant line mid-turn is a tool-call preamble, so asserting ALLOW on
      // it was content-dependent and flaky. (That flake is the same
      // read-during-write class that produced the three live false blocks — see
      // the ticket.) This probe's job is PERFORMANCE + no-crash/no-hang on a
      // real-shaped 35MB file, so assert exactly that and leave the verdict to
      // the deterministic synthetic cases above.
      const biggest = path.join(TMP, 'real-copy.jsonl');
      fs.copyFileSync(path.join(realDir, files[0].f), biggest);
      const r = await runHook(payload(biggest));
      const c = classify(r);
      const nm = `I1 REAL biggest transcript (${(files[0].s / 1e6).toFixed(1)}MB) grades within cap, no crash/hang`;
      if (c.verdict === 'HANG' || c.verdict === 'CRASH') bad(nm, `${c.verdict} (${c.reason}) [${r.ms}ms]`);
      else ok(nm + ` (${c.verdict}, ${r.ms}ms)`);
      if (!r.timedOut && r.ms > 3000) bad('I1-latency', `took ${r.ms}ms (> 3s watchdog target) on a real transcript`);
    } else { ok('I1 no real transcript available (skip)'); }
  } catch (e) { ok('I1 real transcript skip (' + e.message + ')'); }

  // Synthetic very large transcript (~250MB) with a compliant final line -> must ALLOW, no hang.
  try {
    const bigPath = path.join(TMP, 'huge.jsonl');
    const ws = fs.createWriteStream(bigPath);
    const filler = jsonl([{ type: 'user', message: { role: 'user', content: 'x'.repeat(900) } }]);
    let written = 0; const target = 250 * 1024 * 1024;
    while (written < target) { ws.write(filler); written += filler.length; }
    ws.write(jsonl([asst('plain non-compliant final line, no digest')]));
    await new Promise((res) => ws.end(res));
    const r = await expect(`I2 synthetic ~250MB transcript -> must not HANG/WEDGE`, payload(bigPath), 'BLOCK');
    console.log(`       (I2 took ${r.ms}ms; watchdog target 3s, hook timeout 5s)`);
  } catch (e) { ok('I2 huge synthetic skip (' + e.message + ')'); }

  /* ── J. FIFO / never-closing transcript (synchronous-read wedge probe) ── */
  try {
    const fifo = path.join(TMP, 'fifo.jsonl');
    const { execSync } = await import('node:child_process');
    execSync(`mkfifo ${JSON.stringify(fifo)}`);
    // Open a writer that never closes, so readFileSync would block on EOF forever.
    const holder = fs.openSync(fifo, 'r+'); cleanup.push(() => { try { fs.closeSync(holder); } catch {} });
    const r = await runHook(payload(fifo));
    const c = classify(r);
    // NON-REALISTIC input: Claude Code always supplies a real, finite JSONL file it
    // just wrote, never a FIFO. A never-EOF FIFO makes the synchronous readFileSync
    // block (the unref'd setTimeout watchdog cannot preempt a sync call). Even so the
    // harness-level outcome is a hook TIMEOUT -> no {"decision":"block"} output ->
    // Claude Code treats it as non-blocking (allow), i.e. degrades to latency, not a
    // hard brick. Oversized REAL files fail open (ERR_STRING_TOO_LONG -> caught ->
    // allow, confirmed). Reported as a WARN, not a suite failure.
    if (c.verdict === 'HANG') { warn('J1 FIFO transcript (non-realistic sync-read block)', `readFileSync not preemptible by watchdog; harness timeout => allow, not block`); }
    else ok(`J1 FIFO transcript -> ${c.verdict} (${r.ms}ms)`);
  } catch (e) { ok('J1 FIFO probe skipped (' + e.message + ')'); }

  /* ── K. ADVISORY MODE IS THE DEFAULT ─────────────────────────────────────
   * Every assert above runs with ORCHARD_STOP_HOOK_ENFORCE=1 injected by
   * runHook() — i.e. the whole pre-existing BLOCK/ALLOW contract is now the
   * ENFORCE-mode contract, re-pointed rather than deleted. Here we clear the
   * opt-in and assert the shipped default can never block. */
  {
    const ADV = { ORCHARD_STOP_HOOK_ENFORCE: '' };
    const badFile = path.join(TMP, 'adv-bad.jsonl');
    fs.writeFileSync(badFile, jsonl([asst('plain prose with no digest at all')]));
    const goodFile = path.join(TMP, 'adv-good.jsonl');
    fs.writeFileSync(goodFile, jsonl([asst('```orchard-digest\n{"items":[{"text":"ok","kind":"done","importance":"high"}]}\n```\ntail prose')]));

    // must-FAIL core: this exact input BLOCKs under the opt-in.
    await expect('K0 ENFORCE opt-in still blocks a non-compliant reply', payload(badFile), 'BLOCK');
    // …and cannot block by default.
    const r = await runHook(payload(badFile), ADV);
    const c = classify(r);
    if (c.verdict === 'BLOCK') bad('K1 ADVISORY default must not block', 'emitted decision:block without the opt-in');
    else if (c.verdict === 'CRASH' || c.verdict === 'HANG') bad('K1 ADVISORY default', c.verdict + ': ' + c.reason);
    else ok('K1 ADVISORY default: non-compliant -> ALLOW (' + r.ms + 'ms)');
    if (/"decision"\s*:\s*"block"/.test(r.stdout)) bad('K2 no block literal in advisory stdout', r.stdout.slice(0, 120));
    else ok('K2 advisory stdout carries no decision:block');
    if (/"systemMessage"/.test(r.stdout)) ok('K3 advisory reports via systemMessage');
    else bad('K3 advisory must still report the violation', 'no systemMessage in stdout: ' + r.stdout.slice(0, 120));

    await expect('K4 ADVISORY: compliant reply -> silent ALLOW', payload(goodFile), 'ALLOW', ADV);

    // Safety invariants hold in advisory mode too.
    await expect('K5 ADVISORY loop cap (stop_hook_active)', payload(badFile, { stop_hook_active: true }), 'ALLOW', ADV);
    await expect('K6 ADVISORY disable env still inert', payload(badFile), 'ALLOW', { ...ADV, ORCHARD_STOP_HOOK_DISABLED: '1' });
    await expect('K7 ADVISORY missing transcript -> fail open', payload(path.join(TMP, 'nope.jsonl')), 'ALLOW', ADV);
    await expect('K8 ADVISORY garbage stdin -> fail open', '{not json', 'ALLOW', ADV);
    await expect('K9 ADVISORY empty stdin -> fail open', '', 'ALLOW', ADV);
    await expect('K10 ADVISORY directory as transcript -> fail open', payload(TMP), 'ALLOW', ADV);

    // Falsey opt-in values must not enable blocking.
    for (const v of ['0', 'false', 'no', '', 'enforce']) {
      const rr = await runHook(payload(badFile), { ORCHARD_STOP_HOOK_ENFORCE: v });
      if (classify(rr).verdict === 'BLOCK') bad(`K11 ORCHARD_STOP_HOOK_ENFORCE="${v}" must not enable blocking`, 'blocked');
      else ok(`K11 ORCHARD_STOP_HOOK_ENFORCE="${v}" does not enable blocking`);
    }
  }

  /* ── done ──────────────────────────────────────────────────────────────── */
  for (const c of cleanup) c();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

  console.log(`\nFEAT-085 adversarial: ${pass} passed, ${fail} failed, ${warnings.length} warn (of ${pass + fail} asserts).`);
  if (warnings.length) { console.log('WARNINGS (non-realistic / robustness notes, not wedges):'); for (const w of warnings) console.log('  - ' + w); }
  if (fail) { console.log('FAILURES:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
  console.log('VERDICT: contract HOLDS (no wedge / no false-positive block on any realistic input).');
}

main().catch((e) => { console.error('harness error:', e); process.exit(2); });
