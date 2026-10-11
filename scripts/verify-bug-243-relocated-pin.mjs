/**
 * BUG-243 — pin/unpin (and rename/delete) must work for a session whose project
 * was RELOCATED on disk: the transcript was moved into the project's new store
 * dir but still records the pre-move cwd, so the recorded cwd no longer encodes
 * to the dir it sits in. Before the fix the cwd/store-dir guard refused every
 * mutation ("…encodes to … The SDK addresses sessions by cwd … Refused.").
 *
 *   node scripts/verify-bug-243-relocated-pin.mjs
 *
 * §1 PURE — resolveSession directly. The MUST-FAIL is synthesized, not diffed
 *    against HEAD: a declaredStore that declares nothing (exactly the pre-fix
 *    behaviour for a normal, non-container dir) still throws 409
 *    encoding-mismatch; the owner-declaring lookup (ownsDir) resolves to the
 *    project's address. Plus the guard's safety invariants: a wrong address that
 *    does not encode to the dir, and an address that resolves elsewhere via a
 *    host symlink, are BOTH still refused even with ownsDir.
 * §2 SERVER, isolated store — a scratch server over a fixture cut from a REAL
 *    transcript (-workspace-a7cont, cwd rewritten to an old relocated path).
 *    Mirrors the user's exact reality: a registered project whose store dir
 *    holds a session recording a different, pre-move cwd. Pin, UNPIN (the user's
 *    symptom), rename and delete all go through the real HTTP routes + the real
 *    SDK. An UNREGISTERED mismatched store stays refused (fix is narrow), and no
 *    other transcript changes.
 * §3 LONG-PATH DATA LOSS (round-2 regression; independent verify run
 *    8a8a2fc6 BROKE on it) — a registered hostPath whose encoding exceeds 200
 *    chars. The SDK's real encoder (Vl) TRUNCATES + hashes beyond 200, so the
 *    plain `encodeCwd` the guard used disagreed with where the SDK actually
 *    goes. MUST-FAIL (pre-fix synthesized): the OLD plain-encoding invariant
 *    ACCEPTS, and a REAL SDK deleteSession then removes a same-id FOREIGN session
 *    in the SDK-canonical (truncated) dir — data loss. After: resolveSession
 *    refuses (sdkEncodeDir(address) != dir). Also PINS sdkEncodeDir against the
 *    SDK's actual behaviour via a real renameSession at a >200-char cwd.
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { renameSession, deleteSession } from '@anthropic-ai/claude-agent-sdk';

const ROOT = path.resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const failures = [];
const check = (n, ok, obs) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}\n        observed: ${typeof obs === 'string' ? obs : JSON.stringify(obs)}`);
  if (ok) pass++; else { fail++; failures.push(n); }
};
async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
const sha = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const encode = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

/* The REAL transcript each fixture session is cut from (same one FEAT-155 uses). */
const TEMPLATE_DIR = path.join(os.homedir(), '.claude', 'projects', '-workspace-a7cont');
const TEMPLATE_SID = '02a7424c-765e-430b-b17a-4aee76a11855';
const TEMPLATE = path.join(TEMPLATE_DIR, `${TEMPLATE_SID}.jsonl`);
if (!fs.existsSync(TEMPLATE)) {
  console.error(`FAIL — the real template transcript is gone: ${TEMPLATE}. Pick another real transcript; do not synthesize silently.`);
  process.exit(1);
}
const TEMPLATE_BODY = fs.readFileSync(TEMPLATE, 'utf8');
const TEMPLATE_CWD = '/workspace/a7cont';
function seedSession(projectsRoot, encodedDir, cwd, mtimeSec, sid = randomUUID()) {
  const dir = path.join(projectsRoot, encodedDir);
  fs.mkdirSync(dir, { recursive: true });
  const body = TEMPLATE_BODY.split(TEMPLATE_SID).join(sid).split(`"cwd":"${TEMPLATE_CWD}"`).join(`"cwd":${JSON.stringify(cwd)}`);
  const f = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(f, body, { mode: 0o600 });
  fs.utimesSync(f, mtimeSec, mtimeSec);
  return { sid, file: f };
}

/* ====================================================================== §1 */
console.log('\n--- §1 pure: resolveSession must-FAIL (synthesized pre-fix) then pass ---');
const TMP1 = fs.mkdtempSync(path.join(os.tmpdir(), 'bug243-pure-'));
const PROJ1 = path.join(TMP1, 'projects');
fs.mkdirSync(PROJ1, { recursive: true });
process.env.CLAUDE_PROJECTS_DIR = PROJ1;
const hist = await import(path.join(ROOT, 'src/lib/session-history.ts'));
const smut = await import(path.join(ROOT, 'src/server/session-mutations.ts'));

// Neutral paths (no real home path) that still reproduce the relocation shape:
// the two encode to DIFFERENT store dirs, exactly like the user's move from
// .../projects/claude-station to .../projects/orchard.
const NEW_HOST = '/opt/projects/orchard-fixture';   // where the project lives now
const OLD_CWD = '/opt/projects/claude-station-fixture'; // what the moved transcript still records
const NEW_DIR = encode(NEW_HOST);
const t = Math.floor(Date.now() / 1000);
const relocated = seedSession(PROJ1, NEW_DIR, OLD_CWD, t - 1000);

// Sanity: the fixture really reproduces the mismatch the user hit.
check('fixture reproduces the mismatch: recorded cwd encodes to a DIFFERENT dir than the store dir it sits in',
  encode(OLD_CWD) !== NEW_DIR, `${encode(OLD_CWD)} != ${NEW_DIR}`);

// MUST-FAIL — the pre-fix behaviour, synthesized: before BUG-243 the lookup
// returned null for any non-container dir, so the guard fell through and threw.
let preFix = null;
try { smut.resolveSession(relocated.sid, NEW_DIR, () => null); } catch (e) { preFix = e; }
check('MUST-FAIL (pre-fix synthesized): with no owner declaration the relocated session is refused (409 encoding-mismatch)',
  preFix?.status === 409 && preFix?.code === 'encoding-mismatch', `${preFix?.status} ${preFix?.code}`);

// The fix: the registry declares the dir as the project's own store (ownsDir).
const ownerLookup = (dir) => (dir === NEW_DIR ? { address: NEW_HOST, recordedCwds: [NEW_HOST], ownsDir: true } : null);
let resolved = null, resolveErr = null;
try { resolved = smut.resolveSession(relocated.sid, NEW_DIR, ownerLookup); } catch (e) { resolveErr = e; }
check('WITH the owner declaration (ownsDir): resolves, and the SDK is addressed by the project hostPath (encodes to this very dir)',
  resolved?.sdkDir === NEW_HOST && encode(resolved.sdkDir) === NEW_DIR && resolved.cwd === OLD_CWD,
  resolveErr ? `threw ${resolveErr.status} ${resolveErr.code}` : `sdkDir=${resolved?.sdkDir}`);

// Safety invariant 1: ownsDir does NOT excuse an address that encodes to a
// DIFFERENT dir — that would let the SDK mutate the wrong store.
let wrongAddr = null;
try { smut.resolveSession(relocated.sid, NEW_DIR, () => ({ address: '/somewhere/else', recordedCwds: [], ownsDir: true })); } catch (e) { wrongAddr = e; }
check('safety: ownsDir with an address that does NOT encode to the dir is still refused (409)',
  wrongAddr?.status === 409 && wrongAddr?.code === 'encoding-mismatch', `${wrongAddr?.status} ${wrongAddr?.code}`);

// Safety invariant 2: an address that resolves elsewhere via a host symlink is
// refused (the SDK realpaths dir before encoding, so the symlink would redirect).
{
  const realTarget = path.join(TMP1, 'real-elsewhere');
  fs.mkdirSync(realTarget, { recursive: true });
  const linkPath = path.join(TMP1, 'linked');
  fs.symlinkSync(realTarget, linkPath);
  const linkDir = encode(linkPath);
  const viaLink = seedSession(PROJ1, linkDir, OLD_CWD, t - 900);
  hist.clearSessionCache?.();
  let symErr = null;
  try { smut.resolveSession(viaLink.sid, linkDir, () => ({ address: linkPath, recordedCwds: [], ownsDir: true })); } catch (e) { symErr = e; }
  check('safety: an address that resolves elsewhere via a host symlink is refused even with ownsDir',
    symErr?.status === 409, `${symErr?.status} ${symErr?.code}`);
}
fs.rmSync(TMP1, { recursive: true, force: true });
delete process.env.CLAUDE_PROJECTS_DIR;

/* ====================================================================== §2 */
console.log('\n--- §2 scratch server: pin / UNPIN / rename / delete the relocated session via the real routes ---');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bug243-'));
const STORE = path.join(TMP, 'store');
const PROJ = path.join(STORE, 'projects');
const DATA = path.join(TMP, 'data');
const REPO = path.join(TMP, 'repo');
fs.mkdirSync(PROJ, { recursive: true });
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(REPO, { recursive: true });
fs.writeFileSync(path.join(REPO, 'README.md'), 'bug243\n');

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const api = async (p, method = 'GET', body) => {
  const r = await fetch(BASE + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};
const server = spawn(process.execPath, [path.join(ROOT, 'src/server/index.ts')], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_CONFIG_DIR: STORE, CLAUDE_PROJECTS_DIR: PROJ },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverErr = '';
server.stderr.on('data', (d) => { serverErr += d; });
try {
  for (let i = 0; i < 160; i++) { try { const r = await fetch(`${BASE}/api/health`); if (r.ok) break; } catch {} await sleep(250); }
  // A registered project; its store dir is encode(REPO). We file a session there
  // whose recorded cwd is a DIFFERENT (pre-move) path — the relocation shape.
  const cr = await api('/api/projects', 'POST', { hostPath: REPO, name: 'BUG258 Relocated', isolation: 'direct' });
  if (cr.status !== 201) throw new Error(`create: ${JSON.stringify(cr.body)}`);
  const proj = cr.body.project;
  const storeDir = encode(REPO);
  const oldCwd = path.join(TMP, 'OLD-location-before-move'); // encodes to a different dir
  const s = seedSession(PROJ, storeDir, oldCwd, Math.floor(Date.now() / 1000) - 2000);
  // An UNREGISTERED store with the same mismatch shape — must stay refused.
  const ghost = seedSession(PROJ, encode('/home/nobody/ghostproj'), '/home/nobody/old-ghost', Math.floor(Date.now() / 1000) - 1900);

  check('precondition: the relocated session records a cwd that does not encode to its store dir',
    encode(oldCwd) !== storeDir, `${encode(oldCwd)} != ${storeDir}`);

  const before = { session: sha(s.file), ghost: sha(ghost.file) };

  // The USER'S symptom and its siblings, in order.
  const pin = await api(`/api/sessions/${s.sid}`, 'PATCH', { pinned: true, dir: storeDir });
  check('PIN the relocated session (was 409 encoding-mismatch before the fix)',
    pin.status === 200 && fs.readFileSync(s.file, 'utf8').includes('"tag":"pinned"'),
    `status=${pin.status} ${JSON.stringify(pin.body?.code ?? pin.body?.error ?? '')}`);
  const unpin = await api(`/api/sessions/${s.sid}`, 'PATCH', { pinned: false, dir: storeDir });
  check('UNPIN the relocated session — the exact user symptom (200, tag cleared on disk)',
    unpin.status === 200 && unpin.body?.session?.pinned === false && !/"tag":"pinned"[^\n]*\n?$/.test(fs.readFileSync(s.file, 'utf8').trimEnd()),
    `status=${unpin.status} pinned=${unpin.body?.session?.pinned} tag=${JSON.stringify(unpin.body?.session?.tag)}`);
  const ren = await api(`/api/sessions/${s.sid}`, 'PATCH', { title: 'relocated renamed', dir: storeDir });
  check('RENAME the relocated session (same guard class)',
    ren.status === 200 && fs.readFileSync(s.file, 'utf8').includes('"customTitle":"relocated renamed"'),
    `status=${ren.status} ${JSON.stringify(ren.body?.code ?? '')}`);

  // The fix is NARROW: a session in an UNREGISTERED store with the same mismatch
  // is still refused — we have no declared address for it.
  const ghostPin = await api(`/api/sessions/${ghost.sid}`, 'PATCH', { pinned: true, dir: encode('/home/nobody/ghostproj') });
  check('anti-regression: an UNREGISTERED mismatched store is STILL refused (409 encoding-mismatch), ghost file untouched',
    ghostPin.status === 409 && ghostPin.body?.code === 'encoding-mismatch' && sha(ghost.file) === before.ghost,
    `status=${ghostPin.status} code=${ghostPin.body?.code}`);

  // DELETE (the destructive sibling) — age it past the live window first.
  fs.utimesSync(s.file, Math.floor(Date.now() / 1000) - 7200, Math.floor(Date.now() / 1000) - 7200);
  const del = await api(`/api/sessions/${s.sid}?dir=${encodeURIComponent(storeDir)}&confirm=${s.sid}`, 'DELETE');
  check('DELETE the relocated session (destructive sibling): gone, backup verified, ghost untouched',
    del.status === 200 && !fs.existsSync(s.file) && sha(ghost.file) === before.ghost,
    `status=${del.status} ${JSON.stringify(del.body?.error ?? del.body?.code ?? '')}`);
} catch (err) {
  check('no exception in §2', false, String(err?.stack || err));
} finally {
  try { server.kill('SIGKILL'); } catch {}
  if (/Error|throw/i.test(serverErr) && fail) console.log(`  [server stderr tail] ${serverErr.slice(-800)}`);
  fs.rmSync(TMP, { recursive: true, force: true });
}

/* ====================================================================== §3 */
console.log('\n--- §3 long-path data loss: SDK truncates >200-char encodings; the guard must agree ---');
const TMP3 = fs.mkdtempSync(path.join(os.tmpdir(), 'bug243-long-'));
const PROJ3 = path.join(TMP3, 'projects');
fs.mkdirSync(PROJ3, { recursive: true });
process.env.CLAUDE_CONFIG_DIR = TMP3;
process.env.CLAUDE_PROJECTS_DIR = PROJ3;
try {
  // A registered project whose hostPath encodes to MORE than 200 chars.
  const longHost = '/opt/' + 'segment-'.repeat(30) + 'end';
  const plainDir = encode(longHost);          // full plain encoding (what the OLD guard used)
  const sdkDir3 = hist.sdkEncodeDir(longHost); // where the SDK actually goes (truncate+hash)
  check('precondition: a >200-char hostPath — plain encoding and the SDK encoding DIVERGE',
    plainDir.length > 200 && sdkDir3 !== plainDir && sdkDir3.length <= 207,
    `plainLen=${plainDir.length} sdkLen=${sdkDir3.length} divergent=${sdkDir3 !== plainDir}`);

  // PIN sdkEncodeDir to the SDK's ACTUAL behaviour: a real renameSession at
  // longHost must land in exactly the dir sdkEncodeDir predicts, and nowhere else.
  {
    const sid = randomUUID();
    const predicted = path.join(PROJ3, sdkDir3);
    fs.mkdirSync(predicted, { recursive: true });
    fs.writeFileSync(path.join(predicted, `${sid}.jsonl`),
      JSON.stringify({ type: 'user', cwd: longHost, sessionId: sid, promptSource: 'typed', message: { role: 'user', content: 'hi' } }) + '\n');
    await renameSession(sid, 'PINCHECK', { dir: longHost });
    const landed = fs.readFileSync(path.join(predicted, `${sid}.jsonl`), 'utf8').includes('"customTitle":"PINCHECK"');
    const onlyDir = fs.readdirSync(PROJ3);
    check('PIN: a real SDK renameSession at the >200-char cwd lands in exactly sdkEncodeDir(cwd), no other dir',
      landed && onlyDir.length === 1 && onlyDir[0] === sdkDir3, `landed=${landed} dirs=${JSON.stringify(onlyDir.map((d) => d.length))}`);
    fs.rmSync(predicted, { recursive: true, force: true });
  }

  // The data-loss setup: "our" session filed under the PLAIN dir (what Orchard's
  // own listing names a long hostPath), and a DIFFERENT, same-id FOREIGN session
  // already living in the SDK-canonical (truncated) dir the SDK will actually hit.
  const sid = randomUUID();
  const ourFile = path.join(PROJ3, plainDir, `${sid}.jsonl`);
  const foreignFile = path.join(PROJ3, sdkDir3, `${sid}.jsonl`);
  fs.mkdirSync(path.dirname(ourFile), { recursive: true });
  fs.mkdirSync(path.dirname(foreignFile), { recursive: true });
  fs.writeFileSync(ourFile, JSON.stringify({ type: 'user', cwd: longHost, sessionId: sid, promptSource: 'typed', message: { role: 'user', content: 'OURS' } }) + '\n');
  fs.writeFileSync(foreignFile, JSON.stringify({ type: 'user', cwd: '/opt/some/other/project', sessionId: sid, promptSource: 'typed', message: { role: 'user', content: 'FOREIGN — must never be touched' } }) + '\n');
  hist.clearSessionCache?.();

  // Mirrors the REAL server lookup (src/server/index.ts declaredStore): a
  // registered project owns the dir its hostPath encodes to THE SDK'S WAY. So
  // for plainDir it returns null (the owner's real store dir is the truncated
  // one), and for the truncated dir it declares the project — the double safety.
  const ownerLookup3 = (dir) => (hist.sdkEncodeDir(longHost) === dir ? { address: longHost, recordedCwds: [longHost], ownsDir: true } : null);

  // MUST-FAIL (pre-fix synthesized): the OLD invariant was plain encodeCwd. It
  // ACCEPTS (encodeCwd(address) === plainDir === dir), and the SDK then addresses
  // the TRUNCATED dir — a different directory holding the foreign session.
  const oldInvariantAccepts = hist.encodeCwd(longHost) === plainDir; // exactly what the pre-fix guard checked
  check('MUST-FAIL (pre-fix synthesized): the OLD plain-encoding invariant ACCEPTS this long-hostPath mutation',
    oldInvariantAccepts, `encodeCwd(address)===dir : ${oldInvariantAccepts}`);
  // Prove it is data loss with the REAL SDK: deleteSession(address) removes the
  // FOREIGN file in the truncated dir, not the one at plainDir the caller named.
  const foreignBefore = fs.existsSync(foreignFile);
  await deleteSession(sid, { dir: longHost });
  check('MUST-FAIL (pre-fix behaviour, REAL SDK): deleteSession(address) destroyed the same-id FOREIGN session in the truncated dir',
    foreignBefore && !fs.existsSync(foreignFile) && fs.existsSync(ourFile),
    `foreignGone=${!fs.existsSync(foreignFile)} ourStillHere=${fs.existsSync(ourFile)}`);

  // AFTER THE FIX: resolveSession refuses — sdkEncodeDir(address) !== plainDir —
  // so the mutation never reaches the SDK and the foreign dir is never addressed.
  let longErr = null, longOk = null;
  try { longOk = smut.resolveSession(sid, plainDir, ownerLookup3); } catch (e) { longErr = e; }
  check('AFTER: resolveSession REFUSES the long-hostPath case (409 encoding-mismatch) — SDK encoder disagrees with the dir',
    longErr?.status === 409 && longErr?.code === 'encoding-mismatch' && !longOk,
    longErr ? `${longErr.status} ${longErr.code}` : `resolved sdkDir=${longOk?.sdkDir}`);

  // And a session that genuinely lives in the SDK-canonical dir (dir === sdkDir3)
  // still resolves — the fix refuses the dangerous case, not every long path.
  const sid2 = randomUUID();
  fs.writeFileSync(path.join(PROJ3, sdkDir3, `${sid2}.jsonl`),
    JSON.stringify({ type: 'user', cwd: '/opt/pre/move/old/path', sessionId: sid2, promptSource: 'typed', message: { role: 'user', content: 'x' } }) + '\n');
  hist.clearSessionCache?.();
  let okLong = null, okErr = null;
  try { okLong = smut.resolveSession(sid2, sdkDir3, ownerLookup3); } catch (e) { okErr = e; }
  check('AFTER: a long-path session actually filed in the SDK-canonical dir DOES resolve (sdkDir === the truncated dir)',
    okLong?.sdkDir === longHost && hist.sdkEncodeDir(okLong.sdkDir) === sdkDir3,
    okErr ? `threw ${okErr.status} ${okErr.code}` : `sdkDir=${okLong?.sdkDir?.length} chars`);
} catch (err) {
  check('no exception in §3', false, String(err?.stack || err));
} finally {
  fs.rmSync(TMP3, { recursive: true, force: true });
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_PROJECTS_DIR;
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed${failures.length ? `\n  failed: ${failures.join('\n          ')}` : ''}`);
process.exit(fail === 0 ? 0 : 1);
