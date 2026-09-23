/**
 * BUG-174 — the three deny messages Orchard OWNS and that reach the model
 * verbatim must each name their own mechanism, so a reader can tell them apart
 * without inference.
 *
 * Sites under test (round 1 proved all three are delivered to the model
 * unwrapped; see the ticket's Activity log):
 *   src/server/agent-bridge.ts      — answerApproval() deny (user pressed Deny)
 *   src/server/agent-bridge.ts      — answerPlan() reject   (plan turned down)
 *   src/server/survivor-delivery.ts — answerApproval() deny  (dashboard deny)
 *
 * NOT under test, and NOT fixable here: the abort site (agent-bridge
 * `signal.addEventListener('abort', … message:'aborted')`). The CLI discards
 * Orchard's text there and substitutes its own `user-rejected` literal.
 *
 * How the strings are obtained (no expected text is hardcoded — that would
 * make this tautological):
 *   - the two agent-bridge defaults are extracted from the real source, and the
 *     run ABORTS if extraction finds nothing (a green on missing input is worse
 *     than no test);
 *   - the dashboard default is observed ON THE REAL WIRE: a fake broker socket
 *     accepts a real `deliverIntoSurvivor()`, sends a real `can_use_tool`
 *     control_request, and the bytes of the resulting control_response are read
 *     back. The extracted literal is cross-checked against those bytes.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/**
 * Stage watchdog: this drives a real socket relay, so a hang must report WHERE
 * it hung rather than time out silently.
 */
let STAGE = 'start';
const stage = (s) => { STAGE = s; console.log(`[stage] ${s}`); };
const watchdog = setTimeout(() => {
  console.error(`\nABORT (hung, NOT a pass): stuck at stage "${STAGE}"`);
  process.exit(3);
}, 25_000);
watchdog.unref?.();

const failures = [];
const check = (name, ok, detail = '') => {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
};
const die = (msg) => { console.error(`\nABORT (test input missing, NOT a pass): ${msg}`); process.exit(2); };

/* ---------- 1. extract the two agent-bridge defaults from the real source ---------- */

const bridge = read('src/server/agent-bridge.ts');
const extract = (label, re) => {
  const m = bridge.match(re);
  if (!m) die(`could not locate the ${label} deny default in src/server/agent-bridge.ts`);
  return m[1];
};
// answerPlan: `message ?? '<default>'` inside the plan-reject resolve.
const PLAN = extract('plan-reject', /answerPlan\([\s\S]{0,1200}?behavior: 'deny',[\s\S]{0,600}?message: message \?\? '([^']+)'/);
// answerApproval: the next `message ?? '<default>'` after answerApproval(.
const APPROVAL = extract('approval-deny', /answerApproval\([\s\S]{0,2400}?behavior: 'deny',[\s\S]{0,600}?message: message \?\? '([^']+)'/);

/* ---------- 2. observe the dashboard default on the real wire ---------- */

const surv = read('src/server/survivor-delivery.ts');
const dashM = surv.match(/behavior: 'deny',[\s\S]{0,600}?message: message \|\| '([^']+)'/);
if (!dashM) die("could not locate the dashboard deny default in src/server/survivor-delivery.ts");
const DASHBOARD_SRC = dashM[1];

stage('extracted agent-bridge literals; standing up the fake broker socket');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bug174-'));
const sock = path.join(tmp, 'broker.sock');
let observed = null;
{
  const lines = [];
  const server = net.createServer((c) => {
    let buf = '';
    c.on('data', (b) => {
      buf += b.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
    });
    // The survivor's stdin side: once the user frame lands, raise a real
    // permission request back at the relay.
    setTimeout(() => {
      c.write(`${JSON.stringify({
        type: 'control_request',
        request_id: 'req-bug174',
        request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'echo hi' } },
      })}\n`);
    }, 60);
  });
  await new Promise((r) => server.listen(sock, r));

  stage('importing src/server/survivor-delivery.ts');
  const mod = await import(new URL('../src/server/survivor-delivery.ts', import.meta.url).href);
  stage('delivering a user frame into the fake survivor');
  let cardId = null;
  const client = (e) => { if (e.t === 'approval-request') cardId = e.requestId; };
  const d = await mod.deliverIntoSurvivor({
    survivor: { sock },
    sdkSessionId: 'bug174-session',
    prompt: 'probe',
    client,
  });
  if (!d) die('deliverIntoSurvivor() returned null — the fake broker socket was not accepted');
  stage('waiting for the relayed approval card');
  for (let i = 0; i < 100 && !cardId; i++) await new Promise((r) => setTimeout(r, 20));
  if (!cardId) die('the relay never raised an approval-request for the control_request');

  // The user answers DENY with no custom message -> the default literal.
  if (!d.answerApproval(cardId, false)) die('answerApproval() did not match the pending request');
  for (let i = 0; i < 100 && !lines.some((l) => l.includes('control_response')); i++) await new Promise((r) => setTimeout(r, 20));
  const resp = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .find((m) => m && m.type === 'control_response');
  if (!resp) die('no control_response reached the (fake) survivor stdin');
  observed = resp.response?.response?.message;
  if (typeof observed !== 'string' || !observed) die('the control_response carried no deny message');
  stage('tearing down the fake broker');
  d.attachClient(null);
  d.finish?.('verify done');           // closes the delivery's socket
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
stage('asserting properties');
const DASHBOARD = observed;

/* ---------- 3. the strings under test, printed ---------- */

const msgs = [
  { site: 'agent-bridge answerApproval (user pressed Deny)', token: 'approval prompt', text: APPROVAL },
  { site: 'agent-bridge answerPlan (plan rejected)', token: 'plan', text: PLAN },
  { site: 'survivor-delivery answerApproval (dashboard deny) [OBSERVED ON WIRE]', token: 'dashboard', text: DASHBOARD },
];
console.log('\n=== model-visible deny strings ===');
for (const m of msgs) console.log(`  [${m.site}]\n    ${JSON.stringify(m.text)}`);
console.log('');

/* ---------- 4. properties ---------- */

check('wire-observed dashboard text matches the source literal', DASHBOARD === DASHBOARD_SRC,
  `wire=${JSON.stringify(DASHBOARD)} src=${JSON.stringify(DASHBOARD_SRC)}`);

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
for (let i = 0; i < msgs.length; i++) {
  for (let j = i + 1; j < msgs.length; j++) {
    const a = msgs[i], b = msgs[j];
    check(`distinct text: ${a.token} vs ${b.token}`, a.text !== b.text);
    const oa = norm(a.text).slice(0, 4).join(' '), ob = norm(b.text).slice(0, 4).join(' ');
    check(`distinct opener (first 4 words): ${a.token} vs ${b.token}`, oa !== ob, `both open "${oa}"`);
  }
}

for (const m of msgs) {
  const owners = msgs.filter((o) => o.text.toLowerCase().includes(m.token));
  check(`mechanism word "${m.token}" appears in exactly one message`,
    owners.length === 1 && owners[0] === m, `found in: ${owners.map((o) => o.token).join(', ') || 'none'}`);
  check(`${m.token}: says what to do next`,
    /\b(do not retry|don't retry|ask |keep planning|wait |stop )/i.test(m.text));
  check(`${m.token}: does not open with the CLI's ambiguous "the user doesn't want to"`,
    !/^the user (doesn't|does not) want to/i.test(m.text.trim()));
  check(`${m.token}: short enough for a hot path (<=160 chars)`, m.text.length <= 160, `${m.text.length} chars`);
}

console.log(`\nBUG-174 denial wording: ${failures.length ? `FAIL — ${failures.length} problem(s)` : 'PASS'}`);
clearTimeout(watchdog);
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
process.exit(0);
