/**
 * FEAT-144 — durable Orchard mirror of the Claude CLI's own jsonl store, so a
 * Claude conversation survives the CLI pruning its store by age
 * (cleanupPeriodDays). NON-VACUOUS (§C): every layer is the real code.
 *
 * PART 1 — mechanics, direct against the REAL mirrorClaudeStore + the REAL
 * session-history reader, over a REALISTIC multi-turn Claude jsonl (thinking +
 * text + tool_use + tool_result — exactly the richness the FEAT-037 recorder
 * would have DROPPED, which is why a filtered recorder was rejected):
 *   - append-only + idempotent: repeated syncs never duplicate; the mirror is
 *     always a byte-identical complete-line PREFIX of the source;
 *   - truncated read: a half-written trailing line is deferred, never mirrored,
 *     and appears exactly once when completed;
 *   - prefix divergence (in-place compaction) → full re-snapshot, no interleave;
 *   - source shorter / source pruned → mirror kept untouched (the record we protect).
 *
 * PART 2 — the USER'S real read path: the running server's /api/transcript route
 *   - while the CLI file exists the route serves it (precedence: a source-only
 *     entry shows through — Claude store is authoritative);
 *   - AFTER the CLI jsonl is removed (the prune) the SAME route still returns 200
 *     and renders the conversation from the mirror — the proof bar.
 *
 * MUST-FAIL baseline (anchored to a CONSTRUCTED no-mirror state, not HEAD): with
 * no mirror on disk, a read after the prune 404s — which is exactly today's loss.
 *
 * Never touches :4317 or the user's ~/.claude — CLAUDE_PROJECTS_DIR and
 * CLAUDE_STATION_DATA are scratch dirs; scratch ports; kills by pid; installs nothing.
 */
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
// MODULE_ROOT lets the must-FAIL pass import mirrorClaudeStore from a PRE-FIX
// (HEAD) export: `F144_MODULE_ROOT=<head-export> node scripts/verify-feat-144…`.
// Unset → the working tree. The HTTP server (part 2) always runs from ROOT.
const MODULE_ROOT = process.env.F144_MODULE_ROOT ? path.resolve(process.env.F144_MODULE_ROOT) : ROOT;

let pass = 0, fail = 0;
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  ok ? pass++ : fail++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanupDirs = [];
const children = [];
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}
const mkscratch = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); cleanupDirs.push(d); return d; };
const countLines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.length).length : 0);

/* ---- a realistic multi-turn Claude-store jsonl, built line by line ---- */
let uuidN = 0;
const nextUuid = () => `00000000-0000-4000-8000-${String(++uuidN).padStart(12, '0')}`;
function line(obj) { return JSON.stringify(obj) + '\n'; }
function userLine(sid, cwd, blocks, parent) {
  return line({ parentUuid: parent, isSidechain: false, userType: 'external', cwd, sessionId: sid,
    version: '2.1.0', type: 'user', message: { role: 'user', content: blocks }, uuid: nextUuid(), timestamp: new Date().toISOString() });
}
function asstLine(sid, cwd, blocks, parent) {
  return line({ parentUuid: parent, isSidechain: false, cwd, sessionId: sid, version: '2.1.0', type: 'assistant',
    message: { role: 'assistant', model: 'claude-opus-4-8', content: blocks }, uuid: nextUuid(), timestamp: new Date().toISOString() });
}
/** A full realistic turn: user prompt → assistant(thinking+text+tool_use) → user(tool_result) → assistant(text). */
function realTurn(sid, cwd, prompt, reply) {
  return userLine(sid, cwd, [{ type: 'text', text: prompt }])
    + asstLine(sid, cwd, [
        { type: 'thinking', thinking: 'Let me check the repo.', signature: 'sig' },
        { type: 'text', text: 'Looking into it.' },
        { type: 'tool_use', id: `toolu_${sid}_${uuidN}`, name: 'Bash', input: { command: 'ls -1' } },
      ])
    + userLine(sid, cwd, [{ type: 'tool_result', tool_use_id: `toolu_${sid}_${uuidN}`, content: 'src\npackage.json' }])
    + asstLine(sid, cwd, [{ type: 'text', text: reply }]);
}

/* ================================ PART 1 ================================ */
async function part1() {
  console.log('\n=== PART 1: mirror mechanics (real mirrorClaudeStore + real reader) ===');
  const data = mkscratch('cs-f143-data-');
  const claudeRoot = mkscratch('cs-f143-claude-');
  process.env.CLAUDE_STATION_DATA = data;
  process.env.CLAUDE_PROJECTS_DIR = claudeRoot;

  const hist = await import(path.join(MODULE_ROOT, 'src/lib/session-history.ts'));
  const ot = await import(path.join(MODULE_ROOT, 'src/server/orchard-transcripts.ts'));
  const tx = await import(path.join(MODULE_ROOT, 'src/server/transcript.ts'));
  console.log(`  (mirror module under test: ${MODULE_ROOT === ROOT ? 'working tree' : MODULE_ROOT})`);

  const cwd = '/home/user/proj-alpha';
  const enc = hist.encodeCwd(cwd);
  const sid = 'sess-alpha-0001';
  const src = path.join(claudeRoot, enc, `${sid}.jsonl`);
  const mirror = path.join(data, 'transcripts', 'anthropic', enc, `${sid}.jsonl`);
  fs.mkdirSync(path.dirname(src), { recursive: true });

  // Turn 1
  fs.writeFileSync(src, realTurn(sid, cwd, 'first prompt alpha', 'done first'));
  const r1 = ot.mirrorClaudeStore(enc, sid);
  check('turn 1 sync APPENDED and mirror is byte-identical to the CLI store',
    r1.status === 'appended' && fs.existsSync(mirror) && fs.readFileSync(mirror).equals(fs.readFileSync(src)),
    { status: r1.status, srcBytes: fs.statSync(src).size, mirrorBytes: fs.statSync(mirror).size });

  // Idempotent re-sync (simulates re-open / restart with nothing new)
  const bytesBefore = fs.statSync(mirror).size, linesBefore = countLines(mirror);
  const r1b = ot.mirrorClaudeStore(enc, sid);
  ot.mirrorClaudeStore(enc, sid); ot.mirrorClaudeStore(enc, sid); // hammer it
  check('re-syncing with nothing new is a NO-OP (up-to-date; no duplicate lines, bytes unchanged)',
    r1b.status === 'up-to-date' && fs.statSync(mirror).size === bytesBefore && countLines(mirror) === linesBefore,
    { status: r1b.status, bytes: fs.statSync(mirror).size, lines: countLines(mirror) });

  // Turn 2 appended to the CLI store
  fs.appendFileSync(src, realTurn(sid, cwd, 'second prompt alpha', 'done second'));
  const srcLines2 = countLines(src);
  const r2 = ot.mirrorClaudeStore(enc, sid);
  check('turn 2 appends ONLY the new lines — mirror == source, line count matches (no double-append)',
    r2.status === 'appended' && fs.readFileSync(mirror).equals(fs.readFileSync(src)) && countLines(mirror) === srcLines2,
    { status: r2.status, srcLines: srcLines2, mirrorLines: countLines(mirror) });

  // Truncated read: a half-written trailing line (CLI mid-flush, no newline)
  const completeBytes = fs.statSync(src).size;
  const partial = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"half-writ';
  fs.appendFileSync(src, partial); // NO trailing newline
  const rp = ot.mirrorClaudeStore(enc, sid);
  const mirrorHasPartial = fs.readFileSync(mirror, 'utf8').includes('half-writ');
  check('a half-written trailing line is DEFERRED — partial-only, and never enters the mirror',
    rp.status === 'partial-only' && !mirrorHasPartial && fs.statSync(mirror).size === completeBytes,
    { status: rp.status, mirrorHasPartial, mirrorBytes: fs.statSync(mirror).size, atCompleteBoundary: completeBytes });

  // Complete that same line
  fs.appendFileSync(src, 'ten"}]}}\n');
  const rc = ot.mirrorClaudeStore(enc, sid);
  const occurrences = fs.readFileSync(mirror, 'utf8').split('half-written').length - 1;
  check('once completed the line appears EXACTLY ONCE and mirror == source again',
    rc.status === 'appended' && fs.readFileSync(mirror).equals(fs.readFileSync(src)) && occurrences === 1,
    { status: rc.status, occurrences, identical: fs.readFileSync(mirror).equals(fs.readFileSync(src)) });

  // Prefix divergence — the CLI rewrote its file in place (compaction), with a
  // different prefix AND longer than the mirror (so it cannot fall to source-shorter).
  const compacted = realTurn(sid, cwd, 'COMPACTED summary alpha', 'compacted reply')
    + realTurn(sid, cwd, 'more alpha', 'more done')
    + realTurn(sid, cwd, 'extra alpha', 'extra done')
    + realTurn(sid, cwd, 'extra2 alpha', 'extra2 done');
  fs.writeFileSync(src, compacted);
  check('(divergence precondition) the rewritten CLI store is longer than the mirror',
    fs.statSync(src).size > fs.statSync(mirror).size, { srcBytes: fs.statSync(src).size, mirrorBytes: fs.statSync(mirror).size });
  const rd = ot.mirrorClaudeStore(enc, sid);
  const mirrorTxt = fs.readFileSync(mirror, 'utf8');
  check('a divergent in-place rewrite triggers a full RE-SNAPSHOT — mirror == new source, no interleaving',
    rd.status === 'recopied' && fs.readFileSync(mirror).equals(fs.readFileSync(src))
      && mirrorTxt.includes('COMPACTED summary alpha') && !mirrorTxt.includes('first prompt alpha'),
    { status: rd.status, identical: fs.readFileSync(mirror).equals(fs.readFileSync(src)) });

  // Source shorter than mirror — the mirror is the more complete record; keep it
  const richMirrorBytes = fs.statSync(mirror).size;
  fs.writeFileSync(src, realTurn(sid, cwd, 'tiny', 'tiny')); // now much smaller than mirror
  const rs = ot.mirrorClaudeStore(enc, sid);
  check('when the CLI store is SHORTER than the mirror, the mirror is kept untouched (record protected)',
    rs.status === 'source-shorter' && fs.statSync(mirror).size === richMirrorBytes,
    { status: rs.status, mirrorBytes: fs.statSync(mirror).size, srcBytes: fs.statSync(src).size });

  // Prune — CLI store removed entirely
  fs.rmSync(src);
  const rm = ot.mirrorClaudeStore(enc, sid);
  const stillReadable = tx.countMessages(mirror, {}).total;
  check('after the CLI store is PRUNED, mirror is untouched and still reads as a full transcript',
    rm.status === 'source-missing' && fs.existsSync(mirror) && stillReadable > 0,
    { status: rm.status, mirrorExists: fs.existsSync(mirror), messages: stillReadable });

  // DEFECT 1 (clean-room BLOCKING) — EARLY-ENTRY equal-size in-place rewrite.
  // A compaction that rewrites the FIRST entry to the SAME byte length, in a file
  // MANY KiB long so the change is OUTSIDE the last 8 KiB. The old fixed tail-window
  // compare returns `up-to-date` (tail matches) and the mirror stays divergent
  // FOREVER; the sound full-prefix compare catches it. MUST FAIL on the HEAD module.
  {
    const sid2 = 'sess-early-eqsize-0001';
    const src2 = path.join(claudeRoot, enc, `${sid2}.jsonl`);
    const mir2 = path.join(data, 'transcripts', 'anthropic', enc, `${sid2}.jsonl`);
    // ~40 turns → ~60 KiB, so entry 0 sits far outside any 8 KiB tail window.
    let big = '';
    for (let t = 0; t < 40; t++) big += realTurn(sid2, cwd, `early entry ${t} AAAA`, `reply ${t}`);
    fs.writeFileSync(src2, big);
    ot.mirrorClaudeStore(enc, sid2);
    const orig = fs.readFileSync(mir2);
    const fileBytes = orig.length;
    // Flip a byte in the FIRST entry (offset ~40 — inside the first line, far from EOF),
    // length preserved. 'A' appears in "early entry 0 AAAA".
    const twisted = Buffer.from(orig);
    const flipAt = twisted.indexOf(0x41); // first 'A'
    const outsideWindow = flipAt < fileBytes - 8192;
    twisted[flipAt] = 0x5a; // 'A' -> 'Z'
    fs.writeFileSync(src2, twisted);
    const req = ot.mirrorClaudeStore(enc, sid2);
    const mirNow = fs.readFileSync(mir2);
    check('DEFECT 1: an EARLY-entry equal-size rewrite OUTSIDE the 8 KiB window is caught → recopied, mirror == new source',
      req.status === 'recopied' && mirNow.equals(twisted) && outsideWindow && fileBytes === twisted.length,
      { status: req.status, flipAt, fileBytes, flipIsOutsideLast8KiB: outsideWindow, mirrorEqualsSource: mirNow.equals(twisted) });
  }

  // DEFECT 2 (clean-room BLOCKING) — CONCURRENT mirror passes must not duplicate.
  // K worker threads all call mirrorClaudeStore on the same session at once (released
  // together by a shared barrier) with the mirror already SHORT of the source, so the
  // race is the check-then-act append. Without the lock the delta is appended K times
  // (clean room measured 12×); the lock serializes → mirror entries == source entries.
  {
    const sid3 = 'sess-concurrent-0001';
    const src3 = path.join(claudeRoot, enc, `${sid3}.jsonl`);
    const mir3 = path.join(data, 'transcripts', 'anthropic', enc, `${sid3}.jsonl`);
    // Seed the mirror with ONE turn, then grow the SOURCE to ~500 turns so the
    // concurrent append has a large delta (wide race window).
    fs.writeFileSync(src3, realTurn(sid3, cwd, 'concurrent seed', 'seed reply'));
    ot.mirrorClaudeStore(enc, sid3);
    const seedLines = countLines(mir3);
    let more = '';
    for (let t = 0; t < 499; t++) more += realTurn(sid3, cwd, `concurrent turn ${t}`, `reply ${t}`);
    fs.appendFileSync(src3, more);
    const srcLines = countLines(src3);

    const K = 12;
    const sab = new SharedArrayBuffer(4);
    const barrier = new Int32Array(sab);
    const moduleUrl = pathToFileURL(path.join(MODULE_ROOT, 'src/server/orchard-transcripts.ts')).href;
    const workerCode = `
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const { moduleUrl, enc, sid, dataDir, claudeRoot, sab } = workerData;
        process.env.CLAUDE_STATION_DATA = dataDir;
        process.env.CLAUDE_PROJECTS_DIR = claudeRoot;
        const ot = await import(moduleUrl);
        const barrier = new Int32Array(sab);
        Atomics.wait(barrier, 0, 0); // all block here until the main thread releases
        let r; try { r = ot.mirrorClaudeStore(enc, sid); } catch (e) { r = { status: 'throw', detail: String((e && e.message) || e) }; }
        parentPort.postMessage(r);
      })();
    `;
    const results = await new Promise((resolve) => {
      const out = [];
      let done = 0;
      for (let w = 0; w < K; w++) {
        const worker = new Worker(workerCode, { eval: true, workerData: { moduleUrl, enc, sid: sid3, dataDir: data, claudeRoot, sab } });
        worker.on('message', (m) => { out.push(m); });
        worker.on('exit', () => { if (++done === K) resolve(out); });
      }
      // Give the workers a moment to reach the barrier, then release them together.
      setTimeout(() => { Atomics.store(barrier, 0, 1); Atomics.notify(barrier, 0); }, 300);
    });
    const mirLines = countLines(mir3);
    const statuses = results.map((r) => r.status).sort();
    check('DEFECT 2: 12 concurrent mirror passes do NOT duplicate — mirror entries == source entries',
      mirLines === srcLines && fs.readFileSync(mir3).equals(fs.readFileSync(src3)),
      { workers: K, seedLines, sourceEntries: srcLines, mirrorEntries: mirLines, workerStatuses: statuses.join(',') });
  }

  // DEFECT 3/4 robustness — a FAILED sync leaves no torn line and no lock/temp litter,
  // and repeated failures do not accumulate. Force failure with a read-only mirror
  // file (writable dir): the r+ append open fails, and the torn-line-proof path plus
  // the finally-release keep the mirror intact and the dir clean.
  {
    const sid4 = 'sess-failsafe-0001';
    const src4 = path.join(claudeRoot, enc, `${sid4}.jsonl`);
    const mir4 = path.join(data, 'transcripts', 'anthropic', enc, `${sid4}.jsonl`);
    fs.writeFileSync(src4, realTurn(sid4, cwd, 'failsafe seed', 'seed'));
    ot.mirrorClaudeStore(enc, sid4);
    const goodBytes = fs.readFileSync(mir4);
    fs.appendFileSync(src4, realTurn(sid4, cwd, 'failsafe more', 'more'));
    fs.chmodSync(mir4, 0o444); // read-only mirror FILE, dir stays writable
    let lastStatus = null;
    for (let i = 0; i < 5; i++) lastStatus = ot.mirrorClaudeStore(enc, sid4).status;
    const dirFiles = fs.readdirSync(path.dirname(mir4));
    const litter = dirFiles.filter((f) => /\.(mirror-lock|mk-|reclaim-|tmp-)/.test(f) || f.includes('.mirror-lock') || f.includes('.mk-') || f.includes('.reclaim-') || f.includes('.tmp-'));
    const mirIntact = fs.readFileSync(mir4).equals(goodBytes);
    const endsWithNewline = goodBytes[goodBytes.length - 1] === 0x0a && mirIntact;
    check('DEFECT 3/4: a failed append leaves the mirror INTACT (no torn line) and the dir with NO lock/temp litter, across 5 repeats',
      (lastStatus === 'error') && mirIntact && endsWithNewline && litter.length === 0,
      { lastStatus, mirrorIntact: mirIntact, endsWithNewline, litterFiles: litter, dirNow: dirFiles });
    fs.chmodSync(mir4, 0o644);
    const recovered = ot.mirrorClaudeStore(enc, sid4);
    check('DEFECT 3/4: once writable again the deferred delta lands exactly once — mirror == source',
      recovered.status === 'appended' && fs.readFileSync(mir4).equals(fs.readFileSync(src4)),
      { status: recovered.status, identical: fs.readFileSync(mir4).equals(fs.readFileSync(src4)) });
  }

  // Unsafe id refused
  const ru = ot.mirrorClaudeStore(enc, '../escape');
  check('an unsafe session id is refused (no write, no crash)',
    ru.status === 'unsafe-id' || ru.status === 'source-missing', { status: ru.status });

  // Resolver picks the mirror up generically, tagged provider 'anthropic'
  const resolved = ot.resolveOrchardSessionFile(enc, sid);
  check('resolveOrchardSessionFile finds the mirror and tags it provider "anthropic" (resume/badge routing)',
    !!resolved && resolved.provider === 'anthropic' && resolved.filePath === mirror,
    resolved ? { provider: resolved.provider } : '(absent)');
}

/* ================================ PART 2 ================================ */
async function startServer(env) {
  const net = await import('node:net');
  const port = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT, env: { ...process.env, PORT: String(port), ...env }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.on('data', (d) => process.stderr.write(`  [server:${port}!] ${d}`));
  children.push(child);
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { await fetch(`${base}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error(`server on ${port} never became healthy`);
  return { child, base, port };
}

async function part2() {
  console.log('\n=== PART 2: the running server serves the mirror through /api/transcript after a prune ===');
  const data = mkscratch('cs-f143b-data-');
  const claudeRoot = mkscratch('cs-f143b-claude-');
  const hostPath = mkscratch('cs-f143b-proj-');
  const srv = await startServer({ CLAUDE_STATION_DATA: data, CLAUDE_PROJECTS_DIR: claudeRoot });

  const reg = await (await fetch(`${srv.base}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath, name: 'f143' }),
  })).json();
  if (!reg.project?.id) throw new Error(`register failed: ${JSON.stringify(reg)}`);
  const enc = hostPath.replace(/[^a-zA-Z0-9]/g, '-');
  const sid = 'sess-beta-http-01';
  const src = path.join(claudeRoot, enc, `${sid}.jsonl`);
  const mirror = path.join(data, 'transcripts', 'anthropic', enc, `${sid}.jsonl`);
  fs.mkdirSync(path.dirname(src), { recursive: true });
  fs.writeFileSync(src, realTurn(sid, hostPath, 'browser question beta', 'browser answer beta'));

  const getTx = async () => { const r = await fetch(`${srv.base}/api/transcript/${enc}/${sid}?tail=100`); return { status: r.status, body: r.status === 200 ? await r.json() : null }; };
  const bodyText = (b) => JSON.stringify(b?.messages ?? []);

  // MUST-FAIL baseline: no mirror on disk yet + no read has happened. Prove that
  // WITHOUT a mirror, a pruned session 404s (today's silent loss), anchored to a
  // constructed no-mirror state.
  {
    const isolatedSid = 'sess-never-mirrored-01';
    const isoSrc = path.join(claudeRoot, enc, `${isolatedSid}.jsonl`);
    fs.writeFileSync(isoSrc, realTurn(isolatedSid, hostPath, 'ghost', 'ghost'));
    fs.rmSync(isoSrc); // prune before any read ever mirrored it
    const g = await fetch(`${srv.base}/api/transcript/${enc}/${isolatedSid}?tail=100`);
    check('MUST-FAIL baseline: a pruned session that was never mirrored is 404 (the loss this fixes)',
      g.status === 404 && !fs.existsSync(path.join(data, 'transcripts', 'anthropic', enc, `${isolatedSid}.jsonl`)),
      { status: g.status });
  }

  // First read: 200, and the read-path hook mirrored it
  const g1 = await getTx();
  check('GET /api/transcript renders the live Claude session AND the read path mirrored it to disk',
    g1.status === 200 && /browser answer beta/.test(bodyText(g1.body)) && fs.existsSync(mirror),
    { status: g1.status, mirrorExists: fs.existsSync(mirror) });

  // Precedence: an entry present ONLY in the CLI store shows through — Claude
  // store is authoritative while it exists (mirror is fallback, not merged).
  fs.appendFileSync(src, asstLine(sid, hostPath, [{ type: 'text', text: 'SOURCE ONLY marker beta' }]));
  const g2 = await getTx();
  check('while the CLI file exists the route serves IT — a source-only entry shows through (precedence unregressed)',
    g2.status === 200 && /SOURCE ONLY marker beta/.test(bodyText(g2.body)),
    { status: g2.status, hasSourceOnly: /SOURCE ONLY marker beta/.test(bodyText(g2.body)) });

  // Idempotency through the route: repeated GETs do not grow the mirror illegitimately
  await getTx(); await getTx();
  check('repeated reads keep the mirror a byte-identical prefix of the CLI store (no route-driven duplication)',
    fs.readFileSync(src).subarray(0, fs.statSync(mirror).size).equals(fs.readFileSync(mirror)),
    { srcBytes: fs.statSync(src).size, mirrorBytes: fs.statSync(mirror).size });

  const preLines = countLines(mirror);

  // THE PROOF: prune the CLI store; the same route still serves from the mirror
  fs.rmSync(src);
  const g3 = await getTx();
  check('THE PROOF: after the CLI jsonl is removed, the SAME route returns 200 and renders from the mirror',
    g3.status === 200 && /browser answer beta/.test(bodyText(g3.body)) && /SOURCE ONLY marker beta/.test(bodyText(g3.body)),
    { status: g3.status, messages: (g3.body?.messages ?? []).length });

  check('the pruned read did not shrink or duplicate the mirror (append-only survivor)',
    countLines(mirror) === preLines,
    { before: preLines, after: countLines(mirror) });

  // The project session list now surfaces the survivor, provider-tagged anthropic
  const sessResp = await (await fetch(`${srv.base}/api/projects/${reg.project.id}/sessions`)).json();
  const row = (sessResp.sessions ?? []).find((s) => s.sessionId === sid);
  check('post-prune the survivor appears in the project session list, tagged provider "anthropic"',
    !!row && row.provider === 'anthropic', row ? { provider: row.provider, title: row.displayTitle } : '(absent)');
}

async function main() {
  await part1();
  await part2();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => { console.error(`\nFATAL: ${err.stack || err.message}`); process.exitCode = 1; })
  .finally(() => {
    for (const c of children) stopByPid(c);
    setTimeout(() => { for (const d of cleanupDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } } process.exit(process.exitCode ?? 1); }, 2000);
  });
