/**
 * verify-feat-116-provider-usage.mts — provider rate-limit window usage, graded
 * against the REAL providers and their own interfaces, plus the failure paths.
 *
 * Cost: ~$0. Codex is read via `codex app-server account/rateLimits/read` (a
 * status method, no model turn); Claude via a GET to the OAuth usage endpoint
 * (no tokens billed). Nothing here starts a model session.
 *
 * What it proves (the FEAT-116 charter):
 *   A. Codex: the normalized snapshot matches what a raw app-server read reports.
 *   B. Claude: the normalized snapshot matches the raw /api/oauth/usage JSON that
 *      the CLI's own /usage view fetches.
 *   C. Failure/degrade paths are bounded and fail-quiet to "unknown" — never a
 *      throw, never a stale value shown as live, never blocking.
 *   D. The request surface (getUsageSnapshots) is synchronous/non-blocking.
 *   E. No OAuth token leaks into any snapshot the UI would render.
 *
 * MUST-FAIL on the pre-change tree: `src/server/provider-usage.ts` did not exist
 * and `GET /api/usage` 404s, so every assertion below is unreachable there.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readCodexUsage, readClaudeUsage, getUsageSnapshots, type ProviderUsage } from '../src/server/provider-usage.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}

const NOW = Math.floor(Date.now() / 1000);

/** Raw codex app-server read, to compare the normalizer against ground truth. */
async function rawCodexRateLimits(): Promise<any | null> {
  return await new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch { return resolve(null); }
    const done = (v: any) => { try { child.kill('SIGKILL'); } catch {} resolve(v); };
    const timer = setTimeout(() => done(null), 8000);
    let buf = ''; let nextId = 0; let rlId = -1;
    const w = (f: any) => { try { child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', ...f }) + '\n'); } catch {} };
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => {
      buf += d; let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        let f: any; try { f = JSON.parse(line); } catch { continue; }
        if (f.id === 0 && f.method == null) { w({ method: 'initialized', params: {} }); rlId = ++nextId; w({ id: rlId, method: 'account/rateLimits/read', params: null }); }
        else if (f.id === rlId && f.method == null) { clearTimeout(timer); done(f.result ?? null); }
      }
    });
    child.once('error', () => { clearTimeout(timer); done(null); });
    child.once('exit', () => { clearTimeout(timer); done(null); });
    w({ id: 0, method: 'initialize', params: { clientInfo: { name: 'verify', version: '0' }, capabilities: {} } });
  });
}

async function rawClaudeUsage(): Promise<any | null> {
  const file = path.join(os.homedir(), '.claude', '.credentials.json');
  let token: string;
  try { token = JSON.parse(fs.readFileSync(file, 'utf8')).claudeAiOauth.accessToken; } catch { return null; }
  try {
    const r = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

function windowShapeOk(u: ProviderUsage): boolean {
  return u.windows.length > 0 && u.windows.every((w) =>
    typeof w.label === 'string' && w.label.length > 0 &&
    typeof w.usedPercent === 'number' && w.usedPercent >= 0 && w.usedPercent <= 100 &&
    (w.resetsAt === null || (typeof w.resetsAt === 'number' && w.resetsAt > NOW - 3600)));
}

async function main(): Promise<void> {
  const realHome = process.env.HOME;
  const realPath = process.env.PATH;

  console.log('\nA. Codex — normalized read matches the raw app-server rateLimits');
  const codex = await readCodexUsage();
  const rawCodex = await rawCodexRateLimits();
  if (rawCodex) {
    check('codex snapshot available', codex.available === true, codex);
    check('codex windows well-formed (label / 0–100% / future reset)', windowShapeOk(codex), codex.windows);
    check('codex asOf is a recent timestamp', codex.asOf != null && Date.now() - codex.asOf < 15000, codex.asOf);
    const five = codex.windows.find((w) => w.label === '5h');
    const wk = codex.windows.find((w) => w.label === 'weekly');
    check('codex has a 5h window', !!five, codex.windows.map((w) => w.label));
    check('codex has a weekly window', !!wk, codex.windows.map((w) => w.label));
    check('5h usedPercent matches raw primary', !!five && five.usedPercent === Math.round(rawCodex.rateLimits.primary.usedPercent), { got: five?.usedPercent, raw: rawCodex.rateLimits?.primary?.usedPercent });
    check('weekly usedPercent matches raw secondary', !!wk && wk.usedPercent === Math.round(rawCodex.rateLimits.secondary.usedPercent), { got: wk?.usedPercent, raw: rawCodex.rateLimits?.secondary?.usedPercent });
    check('exactly one window is marked binding', codex.windows.filter((w) => w.binding).length === 1);
    console.log(`     (codex live: ${codex.windows.map((w) => `${w.label} ${w.usedPercent}%`).join(' · ')}, plan ${codex.plan})`);
  } else {
    console.log('  SKIP codex — no live app-server (not installed / not signed in); normalizer failure path still graded in C');
    check('codex unavailable is fail-quiet (available:false, note set)', codex.available === false && !!codex.note, codex);
  }

  console.log('\nB. Claude — normalized read matches the raw /api/oauth/usage JSON');
  const claude = await readClaudeUsage();
  const rawClaude = await rawClaudeUsage();
  if (rawClaude) {
    check('claude snapshot available', claude.available === true, claude);
    check('claude windows well-formed (label / 0–100% / future reset)', windowShapeOk(claude), claude.windows);
    check('claude asOf is a recent timestamp', claude.asOf != null && Date.now() - claude.asOf < 15000, claude.asOf);
    const five = claude.windows.find((w) => w.label === '5h');
    const wk = claude.windows.find((w) => w.label === 'weekly');
    check('claude has a 5h window', !!five);
    check('claude has a weekly window', !!wk);
    check('5h usedPercent matches raw five_hour.utilization', !!five && five.usedPercent === Math.round(rawClaude.five_hour.utilization), { got: five?.usedPercent, raw: rawClaude.five_hour?.utilization });
    check('weekly usedPercent matches raw seven_day.utilization', !!wk && wk.usedPercent === Math.round(rawClaude.seven_day.utilization), { got: wk?.usedPercent, raw: rawClaude.seven_day?.utilization });
    check('at least one window is marked binding', claude.windows.some((w) => w.binding));
    console.log(`     (claude live: ${claude.windows.map((w) => `${w.label} ${w.usedPercent}%`).join(' · ')}, plan ${claude.plan})`);

    console.log('\nE. Leak — no OAuth token appears in the rendered snapshot');
    const token = JSON.parse(fs.readFileSync(path.join(realHome!, '.claude', '.credentials.json'), 'utf8')).claudeAiOauth.accessToken as string;
    check('token absent from claude snapshot JSON', !JSON.stringify(claude).includes(token));
    check('token absent from full /api/usage-style payload', !JSON.stringify({ providers: getUsageSnapshots() }).includes(token));
  } else {
    console.log('  SKIP claude live match — no usable credential/network; failure paths still graded in C');
    check('claude unavailable is fail-quiet (available:false, note set)', claude.available === false && !!claude.note, claude);
  }

  console.log('\nC. Failure / degrade paths — bounded, fail-quiet, no throw');

  // C1: Codex binary genuinely absent — HOME + PATH pointed at an empty dir.
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'feat116-empty-'));
  process.env.HOME = emptyHome;
  process.env.PATH = emptyHome; // no `codex` on PATH nor in ~/.local/bin etc.
  const notFound = await readCodexUsage();
  check('codex not-found → unavailable, no throw', notFound.available === false && /not found/i.test(notFound.note ?? ''), notFound.note);
  process.env.HOME = realHome; process.env.PATH = realPath;

  // C2: Codex hang — a fake app-server that never answers must be killed at the
  // timeout (proves the bound and that we never wedge on a stuck provider).
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat116-hang-'));
  const fakeCodex = path.join(fakeDir, 'codex');
  fs.writeFileSync(fakeCodex, '#!/bin/sh\ncat >/dev/null\nsleep 60\n', { mode: 0o755 });
  // Prepend the fake to the REAL PATH so detectCodex finds it first (PATH dirs
  // are scanned before ~/.local/bin) while the child still resolves sh/cat/sleep.
  process.env.PATH = `${fakeDir}${path.delimiter}${realPath}`;
  const t2 = Date.now();
  const hang = await readCodexUsage({ timeoutMs: 700 });
  const hangMs = Date.now() - t2;
  process.env.PATH = realPath;
  check('codex hang → timed-out unavailable', hang.available === false && /timed out/i.test(hang.note ?? ''), hang.note);
  check('codex hang bounded (< 2s for a 700ms budget)', hangMs < 2000, hangMs);

  // C3: Claude not signed in — HOME with no .claude.
  process.env.HOME = emptyHome;
  const noCred = await readClaudeUsage();
  process.env.HOME = realHome;
  check('claude no-credential → unavailable, no throw', noCred.available === false && /sign|credential/i.test(noCred.note ?? ''), noCred.note);

  // C4: Claude network black-hole — non-routable host, tight budget → timeout.
  //     (Uses the real token so it exercises the actual request path, but the
  //     request never reaches a server; TEST-NET-1 is guaranteed unroutable.)
  if (realHome && fs.existsSync(path.join(realHome, '.claude', '.credentials.json'))) {
    const t4 = Date.now();
    const to = await readClaudeUsage({ url: 'http://192.0.2.1/', timeoutMs: 700 });
    const toMs = Date.now() - t4;
    check('claude network timeout → timed-out unavailable', to.available === false && /timed out/i.test(to.note ?? ''), to.note);
    check('claude timeout bounded (< 2s for a 700ms budget)', toMs < 2000, toMs);
  }

  // C5: Claude bad token → 401/403 → unavailable (real endpoint, bogus token).
  const badHome = fs.mkdtempSync(path.join(os.tmpdir(), 'feat116-badtok-'));
  fs.mkdirSync(path.join(badHome, '.claude'));
  fs.writeFileSync(path.join(badHome, '.claude', '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-not-a-real-token', subscriptionType: 'test' } }));
  process.env.HOME = badHome;
  const badTok = await readClaudeUsage();
  process.env.HOME = realHome;
  check('claude bad-token → unavailable, no throw', badTok.available === false && !!badTok.note, badTok.note);
  check('claude bad-token note carries NO token', !(badTok.note ?? '').includes('sk-ant'), badTok.note);

  console.log('\nD. Request surface is synchronous / non-blocking');
  const t5 = Date.now();
  const snaps = getUsageSnapshots();
  const snapMs = Date.now() - t5;
  check('getUsageSnapshots returns instantly (< 50ms, no await)', snapMs < 50, snapMs);
  check('getUsageSnapshots returns both providers', snaps.length === 2 && snaps.some((s) => s.provider === 'anthropic') && snaps.some((s) => s.provider === 'openai'), snaps.map((s) => s.provider));
  check('every snapshot has an available flag + windows array', snaps.every((s) => typeof s.available === 'boolean' && Array.isArray(s.windows)));

  // cleanup
  for (const d of [emptyHome, fakeDir, badHome]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
