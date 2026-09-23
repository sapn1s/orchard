#!/usr/bin/env node
/**
 * verify-feat-145-usage.mjs — FEAT-145 step 7: PER-ACCOUNT quota reporting.
 *
 *   node scripts/verify-feat-145-usage.mjs
 *
 * Two Claude subscriptions are two INDEPENDENT 5-hour windows. The number that
 * tells you WHEN TO SWITCH only exists if each account is read, cached, keyed and
 * displayed separately — while the single-account user's experience stays exactly
 * as it was. This suite grades that, printing OBSERVED VALUES rather than bare
 * PASS/FAIL, in five sections:
 *
 *   A. BURN HISTORY KEYING (scripts/lib/usage-history.mjs) — the part most easily
 *      got wrong. Pre-existing `anthropic` rows must stay BYTE-IDENTICAL, and
 *      `priorFor()` must keep matching them, when a new `anthropic:<id>` account
 *      starts writing. Anchored by a synthesized MUST-FAIL: the naive keying that
 *      writes the default as `anthropic:default` breaks that match, proving the
 *      assertion is not vacuous. Includes truncated reads of the REAL history
 *      file (docs/CONVENTIONS: if another process writes it, grade partial reads).
 *   B. PER-ACCOUNT READS + CACHE REKEY (src/server/provider-usage.ts), against a
 *      LOCAL STUB of the OAuth usage endpoint — the live Anthropic endpoint is
 *      never contacted. Two accounts with different resetsAt must not collapse;
 *      one account's 401 / timeout / pending state must not touch the other's.
 *   C. SINGLE-ACCOUNT BACK-COMPAT, in a CHILD PROCESS with an empty registry, so
 *      the module cache from section B cannot contaminate it: `/api/usage`'s
 *      payload is the pre-145 pair in the pre-145 order, and the default account
 *      is what `.find(s => s.provider === 'anthropic')` resolves to.
 *   D. THE BADGE + TOOLTIP, graded against the REAL public/app.js source (the
 *      functions are extracted from the file, never re-implemented here), with
 *      the pre-145 selection logic synthesized inline as a FIXED baseline —
 *      never `git show HEAD:` , which stops being a pre-fix state the moment the
 *      fix lands (docs/CONVENTIONS).
 *
 * Isolation: a scratch HOME and a scratch CLAUDE_STATION_DATA throughout. The
 * real `~/.claude` is never written, and the real usage-burn-history.jsonl is
 * only ever READ (copied to scratch before any mutation).
 */
import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  KEEP,
  appendHistory,
  histKey,
  histKeyForSnapshot,
  priorFor,
  readHistory,
  rowsFromSnapshots,
} from './lib/usage-history.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
function check(name, cond, observed) {
  if (cond) { pass++; console.log(`  ok   ${name}${observed !== undefined ? `  — ${fmt(observed)}` : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${observed !== undefined ? `  — ${fmt(observed)}` : ''}`); }
}
function fmt(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 220 ? `${s.slice(0, 217)}…` : s;
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* The REAL history file — captured BEFORE any env mutation, and only read. */
const REAL_HISTORY = path.join(os.homedir(), '.local', 'share', 'claude-station', 'usage-burn-history.jsonl');
const REAL_HOME = os.homedir();

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'feat145-usage-'));

async function main() {
  console.log('\nFEAT-145 step 7 — per-account quota reporting\n');

  /* ==================================================================== A */
  console.log('A. BURN HISTORY KEYING — scripts/lib/usage-history.mjs');

  const realRaw = fs.existsSync(REAL_HISTORY) ? fs.readFileSync(REAL_HISTORY, 'utf8') : '';
  if (!realRaw.trim()) {
    // Fail LOUDLY rather than quietly grading nothing (docs/CONVENTIONS: a check
    // that finds no candidate and reports success proves nothing).
    check('[A0] PRECONDITION: a real usage-burn-history.jsonl exists to grade against', false, REAL_HISTORY);
  } else {
    const realRows = readHistory(REAL_HISTORY);
    const realAnthropic = realRows.filter((r) => r.provider === 'anthropic');
    check('[A0] real history read', realRows.length > 0, `${realRows.length} rows, ${realAnthropic.length} keyed 'anthropic', ${realRaw.length} bytes`);
    check('[A0] PRECONDITION: the real file carries pre-existing bare-`anthropic` rows', realAnthropic.length > 0, realAnthropic.length);

    /* --- A1. truncated reads of the REAL artifact ----------------------- */
    const cuts = [0, 1, 40, 94, 95, Math.floor(realRaw.length / 3), Math.floor(realRaw.length / 2), realRaw.length - 1, realRaw.length];
    let truncOk = true;
    const truncObs = [];
    for (const cut of cuts) {
      const f = path.join(TMP, `trunc-${cut}.jsonl`);
      fs.writeFileSync(f, realRaw.slice(0, cut));
      let rows;
      try { rows = readHistory(f); } catch (e) { truncOk = false; truncObs.push(`${cut}:THREW ${e.message}`); continue; }
      const nlCount = realRaw.slice(0, cut).split('\n').filter((l) => l.trim()).length;
      // Property: what a truncated read returns is a PREFIX of the full parse —
      // a torn tail line is dropped, nothing before it is corrupted or reordered.
      const isPrefix = rows.every((r, i) => JSON.stringify(r) === JSON.stringify(realRows[i]));
      const bounded = rows.length <= realRows.length && rows.length >= nlCount - 1;
      if (!isPrefix || !bounded) truncOk = false;
      truncObs.push(`${cut}B→${rows.length}rows`);
    }
    check('[A1] readHistory over the REAL file truncated at 9 points: never throws, always a clean prefix', truncOk, truncObs.join(' '));

    /* --- A2. byte identity of pre-existing rows ------------------------- */
    const NEW_ID = 'a1b2c3d4e5f60718';
    const NEW_KEY = histKey('anthropic', NEW_ID);
    check('[A2] the new account key is `anthropic:<id>`', NEW_KEY === `anthropic:${NEW_ID}`, NEW_KEY);
    // The default is claimed by NAME (see A7): `null` is no longer a synonym for it.
    check('[A2] the DEFAULT account key is the bare, pre-145 `anthropic`', histKey('anthropic', 'default') === 'anthropic', histKey('anthropic', 'default'));

    const fA = path.join(TMP, 'hist-a2.jsonl');
    fs.writeFileSync(fA, realRaw);
    const beforeLines = fs.readFileSync(fA, 'utf8').split('\n').filter((l) => l.trim());
    const beforeAnth = beforeLines.filter((l) => JSON.parse(l).provider === 'anthropic');
    const now = Date.now();
    appendHistory(
      [
        { provider: NEW_KEY, label: '5h', usedPercent: 42, resetsAt: 1788600000, at: now },
        { provider: NEW_KEY, label: 'weekly', usedPercent: 7, resetsAt: 1788990000, at: now },
      ],
      fA,
    );
    const afterLines = fs.readFileSync(fA, 'utf8').split('\n').filter((l) => l.trim());
    const afterAnth = afterLines.filter((l) => JSON.parse(l).provider === 'anthropic');
    const hBefore = sha(beforeAnth.join('\n'));
    const hAfter = sha(afterAnth.join('\n'));
    check('[A2] pre-existing `anthropic` rows are BYTE-IDENTICAL after a new account writes', hBefore === hAfter && beforeAnth.length === afterAnth.length, `sha before=${hBefore} after=${hAfter} (${beforeAnth.length} rows both)`);
    check('[A2] the new account\'s rows were actually written (non-vacuous)', afterLines.filter((l) => JSON.parse(l).provider === NEW_KEY).length === 2, afterLines.length - beforeLines.length);

    /* --- A3. a FULL run (default + new account) vs a synthesized pre-145 run */
    const fPre = path.join(TMP, 'hist-a3-pre.jsonl');
    const fPost = path.join(TMP, 'hist-a3-post.jsonl');
    fs.writeFileSync(fPre, realRaw);
    fs.writeFileSync(fPost, realRaw);
    const defaultRows = [
      { provider: 'anthropic', label: '5h', usedPercent: 63, resetsAt: 1788700000, at: now },
      { provider: 'anthropic', label: 'weekly', usedPercent: 21, resetsAt: 1788990000, at: now },
    ];
    appendHistory(defaultRows, fPre); // synthesized PRE-145 run: default account only
    appendHistory([...defaultRows, { provider: NEW_KEY, label: '5h', usedPercent: 42, resetsAt: 1788600000, at: now }], fPost);
    const anthOf = (f) => fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).filter((l) => JSON.parse(l).provider === 'anthropic').join('\n');
    check('[A3] a full post-145 run leaves the `anthropic` series byte-identical to the pre-145 run', sha(anthOf(fPre)) === sha(anthOf(fPost)), `pre=${sha(anthOf(fPre))} post=${sha(anthOf(fPost))}`);

    /* --- A4. priorFor still matches the default account's history ------- */
    const histPost = readHistory(fPost);
    const anchor = realAnthropic.filter((r) => r.label === '5h').sort((a, b) => b.at - a.at)[0];
    check('[A4] PRECONDITION: a real 5h row exists to match against', !!anchor, anchor);
    if (anchor) {
      const hit = priorFor(histPost, histKey('anthropic', 'default'), anchor.label, anchor.resetsAt);
      check('[A4] priorFor() still finds the DEFAULT account\'s pre-existing row after the change', !!hit && hit.resetsAt === anchor.resetsAt, hit && `used=${hit.usedPercent}% resetsAt=${hit.resetsAt} at=${hit.at}`);

      /* --- A5. the MUST-FAIL twin: naive keying breaks exactly that ----- */
      const fNaive = path.join(TMP, 'hist-a5-naive.jsonl');
      fs.writeFileSync(fNaive, realRaw);
      const naiveKey = (provider, id) => (provider === 'anthropic' ? `anthropic:${id ?? 'default'}` : provider); // the WRONG scheme
      appendHistory(defaultRows.map((r) => ({ ...r, provider: naiveKey('anthropic', 'default') })), fNaive);
      const histNaive = readHistory(fNaive);
      const naiveHit = priorFor(histNaive, naiveKey('anthropic', 'default'), anchor.label, anchor.resetsAt);
      check('[A5] MUST-FAIL twin: under naive `anthropic:default` keying the pre-existing history NO LONGER matches', naiveHit === null, `naive lookup → ${naiveHit === null ? 'null (history lost)' : JSON.stringify(naiveHit)}`);
      const naiveAnth = fs.readFileSync(fNaive, 'utf8').split('\n').filter((l) => l.trim()).filter((l) => JSON.parse(l).provider === 'anthropic');
      check('[A5] MUST-FAIL twin: naive keying also strands the old rows in a dead bucket', naiveAnth.length === beforeAnth.length, `${naiveAnth.length} orphaned rows keyed 'anthropic' with nothing appending to them`);
    }

    /* --- A6. per-key KEEP buckets, and no cross-account matching -------- */
    const fKeep = path.join(TMP, 'hist-a6.jsonl');
    const many = [];
    for (let i = 0; i < 10; i++) {
      many.push({ provider: 'anthropic', label: '5h', usedPercent: i, resetsAt: 111, at: 1000 + i });
      many.push({ provider: NEW_KEY, label: '5h', usedPercent: 50 + i, resetsAt: 222, at: 1000 + i });
    }
    appendHistory(many, fKeep);
    const kept = readHistory(fKeep);
    const keptDefault = kept.filter((r) => r.provider === 'anthropic');
    const keptNew = kept.filter((r) => r.provider === NEW_KEY);
    check(`[A6] each account gets its OWN KEEP=${KEEP} bucket (not a shared one)`, keptDefault.length === KEEP && keptNew.length === KEEP, `default=${keptDefault.length} new=${keptNew.length} total=${kept.length}`);
    check('[A6] priorFor() never returns the OTHER account\'s row', priorFor(kept, 'anthropic', '5h', 222) === null && priorFor(kept, NEW_KEY, '5h', 111) === null, 'cross-account lookups → null');
    check('[A6] each account\'s own lookup still resolves', priorFor(kept, 'anthropic', '5h', 111)?.usedPercent === 9 && priorFor(kept, NEW_KEY, '5h', 222)?.usedPercent === 59, `default=${priorFor(kept, 'anthropic', '5h', 111)?.usedPercent}% new=${priorFor(kept, NEW_KEY, '5h', 222)?.usedPercent}%`);

    /* --- A7. the default is claimed by NAME, never by absence -----------
     * Residual from the steps 6+7 clean-room round: `histKey` used to read
     * `if (!accountId || accountId === 'default')`, so EVERY falsy id wrote into
     * the DEFAULT account's append-only series and fabricated a burn rate for it.
     * The verifier reclassified it unreachable — but only because the registry's
     * hex ID_RE drops such ids UPSTREAM, in claude-accounts.ts, i.e. the guard did
     * not live in the file that depends on it. These checks put it here, and the
     * must-FAIL twin below re-implements the old falsy-default rule inline (a
     * FIXED anchor — never `git show`, which stops being pre-fix once this lands)
     * to prove the assertion is not vacuous.
     */
    const FALSY = [['\'\'', ''], ['undefined', undefined], ['null', null], ['0', 0], ['false', false]];
    const oldFalsyDefault = (provider, accountId) => {   // THE PRE-FIX RULE, verbatim
      if (provider !== 'anthropic') return provider;
      if (!accountId || accountId === 'default') return 'anthropic';
      return `anthropic:${accountId}`;
    };
    const rejected = [];
    const accepted = [];
    const foldedByOldRule = [];
    for (const [label, value] of FALSY) {
      try { accepted.push(`${label}→${JSON.stringify(histKey('anthropic', value))}`); }
      catch { rejected.push(label); }
      if (oldFalsyDefault('anthropic', value) === 'anthropic') foldedByOldRule.push(label);
    }
    check('[A7] every falsy account id is REJECTED, not folded into the default account\'s series',
      rejected.length === FALSY.length && accepted.length === 0,
      `rejected: ${rejected.join(', ')} (of ${FALSY.length})${accepted.length ? `; SILENTLY ACCEPTED: ${accepted.join(', ')}` : ''}`);
    check('[A7] MUST-FAIL twin: the pre-fix falsy-default rule silently folds all five into the bare `anthropic` key',
      foldedByOldRule.length === FALSY.length,
      `pre-fix rule returns 'anthropic' for: ${foldedByOldRule.join(', ')}`);
    check('[A7] the rejection NAMES the offending value and says why (not a bare TypeError)',
      (() => { try { histKey('anthropic', ''); return false; } catch (e) { return /burn-history/.test(e.message) && /'default'/.test(e.message) && /""/.test(e.message); } })(),
      (() => { try { histKey('anthropic', ''); return 'no throw'; } catch (e) { return e.message.slice(0, 120); } })());
    check('[A7] a whitespace-only id is rejected too (it is not an account)',
      (() => { try { histKey('anthropic', '   '); return false; } catch { return true; } })(), 'histKey(\'anthropic\', \'   \') → threw');
    check('[A7] the explicit `default` sentinel STILL produces the bare `anthropic` key (on-disk keying unchanged)',
      histKey('anthropic', 'default') === 'anthropic' && histKeyForSnapshot({ provider: 'anthropic', accountId: 'default' }) === 'anthropic',
      `histKey=${histKey('anthropic', 'default')} histKeyForSnapshot=${histKeyForSnapshot({ provider: 'anthropic', accountId: 'default' })}`);
    check('[A7] a non-anthropic provider is untouched by the guard (no account axis)',
      histKey('openai', null) === 'openai' && histKeyForSnapshot({ provider: 'openai', accountId: null }) === 'openai', 'openai / openai');

    /* A7b. the guard changes nothing on disk: a REAL-history run keyed by the
     * explicit sentinel leaves every pre-existing `anthropic` row byte-identical,
     * and priorFor() keeps matching them (no silent burn-rate reset). */
    const fGuard = path.join(TMP, 'hist-a7.jsonl');
    fs.writeFileSync(fGuard, realRaw);
    const guardBeforeAnth = fs.readFileSync(fGuard, 'utf8').split('\n').filter((l) => l.trim()).filter((l) => JSON.parse(l).provider === 'anthropic');
    const sentinelKey = histKey('anthropic', 'default');
    appendHistory([{ provider: sentinelKey, label: 'weekly', usedPercent: 33, resetsAt: 1788990000, at: now + 1 }], fGuard);
    const guardAfter = fs.readFileSync(fGuard, 'utf8').split('\n').filter((l) => l.trim());
    const guardAfterAnth = guardAfter.filter((l) => JSON.parse(l).provider === 'anthropic');
    // The only legitimate difference is KEEP pruning of the OLDEST row in the
    // bucket just written to (documented behaviour, exercised in A6). Every row
    // that survives must be byte-identical to what was on disk before.
    const appendedLine = guardAfter.find((l) => { const r = JSON.parse(l); return r.usedPercent === 33 && r.at === now + 1; });
    const retained = guardAfterAnth.filter((l) => l !== appendedLine);
    const pruned = guardBeforeAnth.filter((l) => !retained.includes(l));
    const hGuardBefore = sha(guardBeforeAnth.filter((l) => !pruned.includes(l)).join('\n'));
    const hGuardAfter = sha(retained.join('\n'));
    const prunedIsOldestWeekly = pruned.length === 0 || (pruned.length === 1 && (() => {
      const r = JSON.parse(pruned[0]);
      const bucket = guardBeforeAnth.map((l) => JSON.parse(l)).filter((x) => x.label === r.label);
      return r.label === 'weekly' && bucket.length >= KEEP && r.at === Math.min(...bucket.map((x) => x.at));
    })());
    check('[A7] every surviving pre-existing `anthropic` row is BYTE-IDENTICAL after a sentinel-keyed run',
      hGuardBefore === hGuardAfter && retained.length === guardBeforeAnth.length - pruned.length && prunedIsOldestWeekly,
      `sha before=${hGuardBefore} after=${hGuardAfter}; ${guardBeforeAnth.length} rows → ${retained.length} retained + 1 appended; pruned=${pruned.length} (KEEP=${KEEP}, oldest of its bucket=${prunedIsOldestWeekly})`);
    const a = realAnthropic.filter((r) => r.label === '5h').sort((x, y) => y.at - x.at)[0];
    if (a) {
      const hit7 = priorFor(readHistory(fGuard), sentinelKey, a.label, a.resetsAt);
      check('[A7] priorFor() still matches the default account\'s prior rows under the guard (no burn-rate reset)',
        !!hit7 && hit7.resetsAt === a.resetsAt, hit7 && `used=${hit7.usedPercent}% resetsAt=${hit7.resetsAt}`);
    }
  }

  /* ==================================================================== B */
  console.log('\nB. PER-ACCOUNT READS + CACHE REKEY — src/server/provider-usage.ts (stubbed endpoint)');

  // --- a local stub of GET /api/oauth/usage, keyed by bearer token.
  const RESETS = { A: 1788600000, B: 1788644444 };
  const hits = new Map();
  const iso = (sec) => new Date(sec * 1000).toISOString();
  const server = http.createServer((req, res) => {
    const auth = String(req.headers.authorization || '');
    const token = auth.replace(/^Bearer\s+/, '');
    hits.set(token, (hits.get(token) ?? 0) + 1);
    if (token === 'tok-hang') return; // never answers — exercises the timeout path
    const which = token === 'tok-A' ? 'A' : token === 'tok-B' ? 'B' : null;
    if (!which) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"unauthorized"}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      five_hour: { utilization: which === 'A' ? 11 : 77, resets_at: iso(RESETS[which]) },
      seven_day: { utilization: which === 'A' ? 4 : 33, resets_at: iso(RESETS[which] + 400000) },
      limits: [],
    }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const STUB_URL = `http://127.0.0.1:${server.address().port}/api/oauth/usage`;

  // --- scratch HOME + scratch data dir with a two-account registry.
  const HOME_B = path.join(TMP, 'home-b');
  const DATA_B = path.join(TMP, 'data-b');
  const cred = (dir, token, plan) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: token, subscriptionType: plan } }));
  };
  fs.mkdirSync(path.join(HOME_B, '.claude', 'projects'), { recursive: true });
  fs.writeFileSync(path.join(HOME_B, '.claude', 'settings.json'), '{}');
  cred(path.join(HOME_B, '.claude'), 'tok-A', 'max'); // the DEFAULT account
  const ID_B = 'b0b0b0b0b0b0b0b0b0b0b0b0';
  const ID_PENDING = 'cccccccccccccccccccccccc';
  const ID_BAD = 'dddddddddddddddddddddddd';
  const ID_HANG = 'eeeeeeeeeeeeeeeeeeeeeeee';
  fs.mkdirSync(path.join(DATA_B, 'claude-accounts'), { recursive: true });
  cred(path.join(DATA_B, 'claude-accounts', ID_B), 'tok-B', 'max');
  fs.mkdirSync(path.join(DATA_B, 'claude-accounts', ID_PENDING), { recursive: true }); // no credentials → pending
  cred(path.join(DATA_B, 'claude-accounts', ID_BAD), 'tok-nope', 'max');
  cred(path.join(DATA_B, 'claude-accounts', ID_HANG), 'tok-hang', 'max');
  fs.writeFileSync(path.join(DATA_B, 'claude-accounts.json'), JSON.stringify({
    accounts: [
      { id: ID_B, label: 'work', dir: path.join(DATA_B, 'claude-accounts', ID_B), createdAt: '2026-09-18T00:00:00Z', state: 'ready' },
      { id: ID_PENDING, label: 'pending one', dir: '', createdAt: '2026-09-18T00:00:00Z', state: 'pending' },
      { id: ID_BAD, label: 'expired one', dir: '', createdAt: '2026-09-18T00:00:00Z', state: 'ready' },
      { id: ID_HANG, label: 'wedged one', dir: '', createdAt: '2026-09-18T00:00:00Z', state: 'ready' },
    ],
  }, null, 2));

  process.env.HOME = HOME_B;
  process.env.CLAUDE_STATION_DATA = DATA_B;
  process.env.CLAUDE_STATION_USAGE_URL = STUB_URL;
  delete process.env.XDG_DATA_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;

  const pu = await import('../src/server/provider-usage.ts');

  const targets = pu.usageTargets();
  const claudeTargets = targets.filter((t) => t.provider === 'anthropic');
  check(`[B1] usageTargets() enumerates every Claude account + openai`, targets.length === 6, targets.map((t) => `${t.provider}${t.accountId ? `/${t.accountLabel}` : ''}`).join(', '));
  check('[B1] the DEFAULT account is FIRST', targets[0]?.provider === 'anthropic' && targets[0]?.accountId === 'default', targets[0]);
  check('[B1] openai is still enumerated, with no account axis', targets.at(-1)?.provider === 'openai' && targets.at(-1)?.accountId === null, targets.at(-1));

  // --- direct per-account reads (no cache) — two distinct windows.
  const snapA = await pu.readClaudeUsage({ accountId: 'default', accountLabel: 'Default (~/.claude)' });
  const snapB = await pu.readClaudeUsage({ accountId: ID_B, accountLabel: 'work' });
  check('[B2] account A reads its OWN window', snapA.available && snapA.windows[0].usedPercent === 11 && snapA.windows[0].resetsAt === RESETS.A, `${snapA.accountLabel}: ${snapA.windows[0]?.usedPercent}% resets ${snapA.windows[0]?.resetsAt}`);
  check('[B2] account B reads its OWN, DIFFERENT window', snapB.available && snapB.windows[0].usedPercent === 77 && snapB.windows[0].resetsAt === RESETS.B, `${snapB.accountLabel}: ${snapB.windows[0]?.usedPercent}% resets ${snapB.windows[0]?.resetsAt}`);
  check('[B2] both snapshots keep provider === "anthropic" (the back-compat constraint)', snapA.provider === 'anthropic' && snapB.provider === 'anthropic', `${snapA.provider} / ${snapB.provider}`);
  check('[B2] each snapshot carries its accountId/accountLabel', snapA.accountId === 'default' && snapB.accountId === ID_B && snapB.accountLabel === 'work', `${snapA.accountId} / ${snapB.accountId}:${snapB.accountLabel}`);

  // --- the CACHE, through the real request surface.
  pu.getUsageSnapshots(claudeTargets); // kicks the background refreshes
  let cached = [];
  for (let i = 0; i < 60; i++) {
    cached = pu.getUsageSnapshots(claudeTargets);
    if (cached.every((s) => s.note !== 'reading…')) break;
    await sleep(100);
  }
  const cA = cached.find((s) => s.accountId === 'default');
  const cB = cached.find((s) => s.accountId === ID_B);
  check('[B3] the cache serves each account its OWN snapshot (rekeyed by provider\\x00accountId)', cA?.windows?.[0]?.resetsAt === RESETS.A && cB?.windows?.[0]?.resetsAt === RESETS.B, `A→${cA?.windows?.[0]?.usedPercent}%/${cA?.windows?.[0]?.resetsAt}  B→${cB?.windows?.[0]?.usedPercent}%/${cB?.windows?.[0]?.resetsAt}`);
  const hitsBefore = `${hits.get('tok-A')}/${hits.get('tok-B')}`;
  const again = pu.getUsageSnapshots(claudeTargets);
  check('[B3] a second read within the TTL still separates the two accounts', again.find((s) => s.accountId === 'default')?.windows?.[0]?.resetsAt === RESETS.A && again.find((s) => s.accountId === ID_B)?.windows?.[0]?.resetsAt === RESETS.B, `A=${again.find((s) => s.accountId === 'default')?.windows?.[0]?.resetsAt} B=${again.find((s) => s.accountId === ID_B)?.windows?.[0]?.resetsAt}`);
  check('[B3] …and serves it from cache without re-hitting the endpoint', hitsBefore === `${hits.get('tok-A')}/${hits.get('tok-B')}`, `endpoint hits A/B before=${hitsBefore} after=${hits.get('tok-A')}/${hits.get('tok-B')}`);

  // MUST-FAIL anchor for the rekey: the pre-145 keying, synthesized inline as a
  // FIXED baseline (never `git show HEAD:` — that stops being pre-fix once the
  // fix lands). Same two snapshots, keyed by provider alone → collapse.
  {
    const preCache = new Map();
    for (const s of [snapA, snapB]) if (!preCache.has(s.provider)) preCache.set(s.provider, s); // pre-145: first writer wins for the TTL
    const servedToB = preCache.get('anthropic');
    check('[B3] MUST-FAIL twin: keyed by provider ALONE, account B is served account A\'s snapshot', servedToB.windows[0].resetsAt === RESETS.A && servedToB.windows[0].usedPercent === 11, `B would see ${servedToB.windows[0].usedPercent}% / resets ${servedToB.windows[0].resetsAt} (that is A's)`);
    check('[B3] MUST-FAIL twin: one cache slot, not two', preCache.size === 1, `pre-145 keys=${preCache.size}, post-145 keys=2`);
  }

  // --- failure isolation: pending / 401 / timeout.
  const snapPending = await pu.readClaudeUsage({ accountId: ID_PENDING, accountLabel: 'pending one' });
  const snapBad = await pu.readClaudeUsage({ accountId: ID_BAD, accountLabel: 'expired one' });
  const snapHang = await pu.readClaudeUsage({ accountId: ID_HANG, accountLabel: 'wedged one', timeoutMs: 600 });
  check('[B4] a PENDING account (no credentials) degrades to unknown, does not throw', snapPending.available === false && /credentials/i.test(snapPending.note ?? ''), `available=${snapPending.available} note=${snapPending.note}`);
  check('[B4] a 401 account degrades to unknown with an honest note', snapBad.available === false && /re-authenticate/i.test(snapBad.note ?? ''), `available=${snapBad.available} note=${snapBad.note}`);
  check('[B4] a WEDGED account times out and degrades — bounded, no throw', snapHang.available === false && /timed out/i.test(snapHang.note ?? ''), `available=${snapHang.available} note=${snapHang.note}`);
  check('[B4] each failure carries its OWN account identity (not another\'s)', snapPending.accountId === ID_PENDING && snapBad.accountId === ID_BAD && snapHang.accountId === ID_HANG, [snapPending.accountLabel, snapBad.accountLabel, snapHang.accountLabel].join(', '));

  // The whole list, read through the request surface WITH the broken accounts in it.
  pu.getUsageSnapshots(claudeTargets);
  let all = [];
  for (let i = 0; i < 80; i++) {
    all = pu.getUsageSnapshots(claudeTargets);
    if (all.every((s) => s.note !== 'reading…')) break;
    await sleep(100);
  }
  const good = all.filter((s) => s.available);
  check('[B4] with 2 broken + 1 wedged account in the list, BOTH healthy accounts still report', good.length === 2 && good.some((s) => s.accountId === 'default') && good.some((s) => s.accountId === ID_B), all.map((s) => `${s.accountLabel}=${s.available ? `${s.windows[0].usedPercent}%` : `unknown(${s.note})`}`).join(' | '));
  check('[B4] the healthy accounts\' values are untouched by the neighbours\' failures', good.find((s) => s.accountId === 'default')?.windows[0].resetsAt === RESETS.A && good.find((s) => s.accountId === ID_B)?.windows[0].resetsAt === RESETS.B, `A=${RESETS.A} B=${RESETS.B}`);

  // --- no credential ever reaches a snapshot.
  const blob = JSON.stringify([snapA, snapB, snapPending, snapBad, snapHang, ...all]);
  check('[B5] no OAuth token appears anywhere in any snapshot', !/tok-A|tok-B|tok-nope|tok-hang|accessToken/.test(blob), `${blob.length} bytes scanned, 0 hits`);

  // --- the history rows this read set would write.
  const rows = rowsFromSnapshots([snapA, snapB, snapPending], Date.now());
  check('[B6] history rows key the default as `anthropic` and the extra account as `anthropic:<id>`', rows.some((r) => r.provider === 'anthropic') && rows.some((r) => r.provider === `anthropic:${ID_B}`) && !rows.some((r) => r.provider === `anthropic:default`), [...new Set(rows.map((r) => r.provider))].join(', '));
  check('[B6] an unavailable account writes NO history row (never a fabricated 0%)', !rows.some((r) => r.provider === `anthropic:${ID_PENDING}`), `${rows.length} rows from 3 snapshots (1 unavailable)`);
  check('[B6] histKeyForSnapshot agrees with histKey', histKeyForSnapshot(snapB) === histKey('anthropic', ID_B), histKeyForSnapshot(snapB));

  /* ==================================================================== C */
  console.log('\nC. SINGLE-ACCOUNT BACK-COMPAT — child process, empty registry');

  const HOME_C = path.join(TMP, 'home-c');
  const DATA_C = path.join(TMP, 'data-c');
  fs.mkdirSync(path.join(HOME_C, '.claude', 'projects'), { recursive: true });
  fs.writeFileSync(path.join(HOME_C, '.claude', 'settings.json'), '{}');
  cred(path.join(HOME_C, '.claude'), 'tok-A', 'max');
  fs.mkdirSync(DATA_C, { recursive: true }); // NO claude-accounts.json at all

  const childPath = path.join(TMP, 'single-account-child.mjs');
  fs.writeFileSync(childPath, `
import { getUsageSnapshots, usageTargets } from ${JSON.stringify(path.join(ROOT, 'src/server/provider-usage.ts'))};
const targets = usageTargets();
// Only the anthropic target, so this child never spawns a codex app-server.
const claude = targets.filter((t) => t.provider === 'anthropic');
let snaps = [];
for (let i = 0; i < 60; i++) {
  snaps = getUsageSnapshots(claude);
  if (snaps.every((s) => s.note !== 'reading…')) break;
  await new Promise((r) => setTimeout(r, 100));
}
const full = getUsageSnapshots();          // exactly what GET /api/usage serves
console.log(JSON.stringify({ targets, snaps, full }));
`);
  // spawn, NOT spawnSync: the stub endpoint lives on THIS process's event loop,
  // so a synchronous spawn would block the server and the child would only ever
  // observe a timeout.
  const child = await new Promise((resolve) => {
    const c = spawn(process.execPath, [childPath], {
      env: { ...process.env, HOME: HOME_C, CLAUDE_STATION_DATA: DATA_C, CLAUDE_STATION_USAGE_URL: STUB_URL },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // own process group, so the timeout kill takes the whole tree
    });
    let stdout = ''; let stderr = '';
    c.stdout.setEncoding('utf8'); c.stderr.setEncoding('utf8');
    c.stdout.on('data', (d) => { stdout += d; });
    c.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { try { process.kill(-c.pid, 'SIGKILL'); } catch { try { c.kill('SIGKILL'); } catch { /* gone */ } } }, 30_000);
    c.once('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
  let childOut = null;
  try { childOut = JSON.parse((child.stdout || '').trim().split('\n').pop()); } catch { /* reported below */ }
  check('[C0] the single-account child ran', !!childOut, child.status === 0 ? 'exit 0' : `exit ${child.status}: ${(child.stderr || '').slice(0, 300)}`);
  if (childOut) {
    const { targets: tC, snaps: sC, full } = childOut;
    check('[C1] an empty registry yields exactly the pre-145 pair of targets', tC.length === 2 && tC[0].provider === 'anthropic' && tC[1].provider === 'openai', tC.map((t) => t.provider).join(', '));
    check('[C1] GET /api/usage returns exactly 2 rows, anthropic first', full.length === 2 && full[0].provider === 'anthropic' && full[1].provider === 'openai', full.map((s) => s.provider).join(', '));
    const found = full.find((s) => s.provider === 'anthropic');
    check('[C2] `.find(s => s.provider === "anthropic")` (public/app.js:443) resolves to the DEFAULT account', found?.accountId === 'default', `accountId=${found?.accountId}`);
    const one = sC[0];
    const preKeys = ['provider', 'available', 'asOf', 'windows', 'plan', 'note'];
    check('[C2] every pre-145 field is still present with its pre-145 type', preKeys.every((k) => k in one), Object.keys(one).join(','));
    check('[C2] the payload is a strict SUPERSET — only accountId/accountLabel added', Object.keys(one).filter((k) => !preKeys.includes(k)).sort().join(',') === 'accountId,accountLabel', Object.keys(one).filter((k) => !preKeys.includes(k)).join(','));
    check('[C2] the single account reports its real window', one.available === true && one.windows[0].usedPercent === 11 && one.windows[0].resetsAt === RESETS.A, `${one.windows?.[0]?.usedPercent}% resets ${one.windows?.[0]?.resetsAt} plan=${one.plan}`);
  }

  /* ==================================================================== D */
  console.log('\nD. BADGE + TOOLTIP — the REAL public/app.js source');

  const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const START = appSrc.indexOf('/** Short relative countdown to a reset');
  const END = appSrc.indexOf("/** The station's own port");
  check('[D0] PRECONDITION: the usage badge/title region was located in public/app.js', START > 0 && END > START, `bytes ${START}..${END}`);
  if (START > 0 && END > START) {
    const region = appSrc.slice(START, END);
    check('[D0] the region contains the functions under test', /function usageTitle\(/.test(region) && /function paintUsageChip\(/.test(region) && /function claudeAccountView\(/.test(region), `${region.length} bytes`);

    const makeUi = () => {
      const state = { usage: null, overrides: {} };
      const lab = { textContent: '' };
      const classes = new Set();
      const btn = {
        title: '', hidden: true,
        classList: { add: (c) => classes.add(c), remove: (...cs) => cs.forEach((c) => classes.delete(c)), has: (c) => classes.has(c) },
      };
      const node = { usageBtn: btn, usageN: lab };
      let project = { id: 'p', settings: {} };
      // Real source, stub environment. The functions are NEVER re-implemented here.
      const build = new Function('state', 'node', 'currentProject', 'providerView',
        `${region}\nreturn { usageTitle, paintUsageChip, claudeAccountView, usageSnapName };`);
      const api = build(state, node, () => project, () => 'anthropic');
      return { state, btn, lab, classes, api, setProject: (p) => { project = p; } };
    };

    // The pre-145 selection logic, synthesized here as a FIXED baseline.
    const preBadgeSnap = (list, provider) => list.find((s) => s.provider === provider);
    const preTitle = (list, usageAsOf, usageResetAbs) => {
      const name = (pv) => (pv === 'openai' ? 'OpenAI' : 'Claude');
      const lines = [];
      for (const pv of ['anthropic', 'openai']) {
        const s = list.find((x) => x.provider === pv);
        if (!s) continue;
        if (!s.available) { lines.push(`${name(pv)} — not available${s.note ? ` (${s.note})` : ''}${s.asOf ? ` · last read ${usageAsOf(s.asOf)}` : ''}`); continue; }
        lines.push(`${name(pv)}${s.plan ? ` (${s.plan})` : ''} — as of ${usageAsOf(s.asOf)}`);
        for (const w of s.windows) lines.push(`  ${w.label}: ${w.usedPercent}%${w.binding ? ' (binding)' : ''} · resets ${usageResetAbs(w.resetsAt)}`);
      }
      lines.push('Rate-limit windows — decide whether a lane fits before dispatching.');
      return lines.join('\n');
    };

    const ASOF = 1789000000000;
    const snap = (accountId, accountLabel, pct, resetsAt, extra = {}) => ({
      provider: 'anthropic', accountId, accountLabel, available: true, asOf: ASOF, plan: 'max', note: null,
      windows: [{ label: '5h', usedPercent: pct, resetsAt, binding: true }, { label: 'weekly', usedPercent: 10, resetsAt: resetsAt + 400000 }],
      ...extra,
    });
    const openai = { provider: 'openai', accountId: null, accountLabel: null, available: true, asOf: ASOF, plan: 'plus', note: null, windows: [{ label: '5h', usedPercent: 5, resetsAt: RESETS.A, binding: true }] };

    // --- D1: one account → indistinguishable from pre-145.
    {
      const ui = makeUi();
      const single = [snap('default', 'Default (~/.claude)', 11, RESETS.A), openai];
      ui.state.usage = single;
      ui.api.paintUsageChip();
      const newLabel = ui.lab.textContent;
      const newTitle = ui.btn.title;
      // The pre-145 badge label, recomputed from the pre-145 snapshot selection.
      const pre = preBadgeSnap(single, 'anthropic');
      const isSame = pre === single[0];
      check('[D1] single account: the badge selects the SAME snapshot the pre-145 code did', isSame, `selected accountId=${single[0].accountId}`);
      check('[D1] single account: badge text is the account\'s binding window', newLabel.startsWith('11% 5h'), `"${newLabel}"`);
      const expectTitle = preTitle(single, (a) => new Date(a).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), (s) => new Date(s * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }));
      check('[D1] single account: the tooltip is BYTE-IDENTICAL to the pre-145 tooltip', newTitle === expectTitle, `sha new=${sha(newTitle)} pre=${sha(expectTitle)}`);
      check('[D1] single account: the account label never appears — the line is plain "Claude"', newTitle.split('\n')[0] === 'Claude (max) — as of ' + new Date(ASOF).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), newTitle.split('\n')[0]);
    }

    // --- D2: two accounts, session pinned to the SECOND one.
    {
      const ui = makeUi();
      const two = [snap('default', 'Default (~/.claude)', 11, RESETS.A), snap(ID_B, 'work', 77, RESETS.B), openai];
      ui.state.usage = two;
      ui.setProject({ id: 'p', settings: { claudeAccount: ID_B } });
      check('[D2] claudeAccountView() reads the project\'s pinned account', ui.api.claudeAccountView() === ID_B, ui.api.claudeAccountView());
      ui.api.paintUsageChip();
      check('[D2] the badge shows the window of the account THIS session will run on', ui.lab.textContent.startsWith('77% 5h'), `"${ui.lab.textContent}"`);
      check('[D2] and is coloured by THAT account\'s pressure, not the default\'s', ui.classes.has('warn') && !ui.classes.has('danger'), [...ui.classes].join(',') || '(none)');
      // MUST-FAIL twin: the pre-145 selection would show the wrong account here.
      const preSel = preBadgeSnap(two, 'anthropic');
      check('[D2] MUST-FAIL twin: pre-145 `.find(provider)` would show the OTHER account', preSel.accountId === 'default' && preSel.windows[0].usedPercent === 11, `pre-145 would render ${preSel.windows[0].usedPercent}% (account "${preSel.accountLabel}") instead of 77%`);
      const title = ui.btn.title;
      check('[D2] the tooltip lists BOTH accounts, each with its own window', /Claude \(work\)/.test(title) && /Claude \(max\)/.test(title) && /77%/.test(title) && /11%/.test(title), title.split('\n').slice(0, 4).join(' / '));
      check('[D2] the tooltip still lists OpenAI', /OpenAI \(plus\)/.test(title), title.split('\n').find((l) => l.startsWith('OpenAI')));
    }

    // --- D3: the pinned account is unknown/unavailable.
    {
      const ui = makeUi();
      const two = [snap('default', 'Default (~/.claude)', 11, RESETS.A), { provider: 'anthropic', accountId: ID_B, accountLabel: 'work', available: false, asOf: null, plan: null, note: 'Claude sign-in expired — re-authenticate', windows: [] }, openai];
      ui.state.usage = two;
      ui.setProject({ id: 'p', settings: { claudeAccount: ID_B } });
      ui.api.paintUsageChip();
      check('[D3] a pinned-but-unreadable account shows "usage —" (unknown), never another account\'s number', ui.lab.textContent === 'usage —' && ui.classes.has('unknown'), `"${ui.lab.textContent}" classes=${[...ui.classes].join(',')}`);
      check('[D3] and the tooltip says WHY, naming the account', /Claude \(work\) — not available \(Claude sign-in expired/.test(ui.btn.title), ui.btn.title.split('\n').find((l) => l.includes('work')));
    }

    // --- D4: a pinned account that is not in the list at all → default fallback.
    {
      const ui = makeUi();
      ui.state.usage = [snap('default', 'Default (~/.claude)', 11, RESETS.A), openai];
      ui.setProject({ id: 'p', settings: { claudeAccount: 'ffffffffffffffffffffffff' } });
      ui.api.paintUsageChip();
      check('[D4] an account with no snapshot yet falls back to the default account, not to blank', ui.lab.textContent.startsWith('11% 5h'), `"${ui.lab.textContent}"`);
    }
  }

  server.close();
  console.log(`\n${pass}/${pass + fail} checks passed${fail ? ` — ${fail} FAILED` : ''}\n`);
  return fail ? 1 : 0;
}

main()
  .then((code) => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } process.exit(code); })
  .catch((err) => {
    console.error(err?.stack || String(err));
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
    process.exit(1);
  });
