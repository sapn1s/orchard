/**
 * verify-feat-096-live-sessions.mts — the fleet switch, observed in REAL sessions.
 *
 * `verify-feat-096-fleet-enabled.mts` grades the configuration. This grades the
 * OUTCOME, which is the only thing FEAT-096 phase 3 was asked for: a session
 * that used to open by grepping the tree must now dispatch instead.
 *
 * It drives the REAL `startSession()` from `agent-bridge.ts` — the same entry
 * the WebSocket `start` command calls — so a container project genuinely starts
 * its container and runs the CLI inside it, and the enforcement hook has to
 * travel over the SDK control channel to matter. Nothing is written into any
 * project tree; that is the property being tested, not an assumption.
 *
 * IT NEVER TOUCHES THE LIVE STATION. It runs against an isolated
 * `CLAUDE_STATION_DATA` under the user's scratch dir, with the real registry's
 * rows MIRRORED into it under distinct project ids (so a container session gets
 * its own container name and cannot adopt the live one).
 *
 * THIS COSTS MONEY: it starts one real model session per project, plus three
 * for the immunity case. It is deliberately NOT in the gate.
 *
 * Usage:
 *   node scripts/verify-feat-096-live-sessions.mts --immunity
 *   node scripts/verify-feat-096-live-sessions.mts --projects=claude-station,kenimai-website
 *   node scripts/verify-feat-096-live-sessions.mts --all
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (n: string) => args.some((a) => a === `--${n}` || a.startsWith(`--${n}=`));
const value = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=') ?? '';

// ISOLATION FIRST — before anything imports a module that resolves dataDir().
const scratch = path.join(os.homedir(), 'scratch', 'feat096-live-sessions');
fs.mkdirSync(scratch, { recursive: true });
const isolated = path.join(scratch, `data-${Date.now().toString(36)}`);
fs.mkdirSync(isolated, { recursive: true });
const realRegistry = path.join(
  process.env.REAL_STATION_DATA?.trim() || path.join(os.homedir(), '.local', 'share', 'claude-station'),
  'registry.json',
);
process.env.CLAUDE_STATION_DATA = isolated;

const reg = await import('../src/server/registry.ts');
const { validateProjectPatch } = await import('../src/server/validate.ts');
const { startSession } = await import('../src/server/agent-bridge.ts');
const { seedTemplates } = await import('../src/server/templates.ts');
/*
 * REALISTIC STATE, not the minimal case. A real session in any of these
 * projects is launched with the working agreement composed into its system
 * prompt — the document whose §I says "Yes → dispatch, at any size". Running
 * these turns with an empty instruction stack would test a session nobody has,
 * and would flatter the result in one direction (no WA) or the other (the WA
 * alone might produce the dispatch without any enforcement). So the isolated
 * data dir is seeded from the same repo sources the live one reads through,
 * and each mirrored row keeps its real `instructions`.
 */
seedTemplates();
type StationEvent = { t: string; [k: string]: unknown };

const checks: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean) => {
  checks.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
};

if (!fs.existsSync(realRegistry)) {
  console.log(`SKIP — no live registry at ${realRegistry}; this verifier mirrors a real fleet, not a fixture.`);
  process.exit(0);
}
const live = JSON.parse(fs.readFileSync(realRegistry, 'utf8')) as { projects: Record<string, unknown>[] };

const browser = await import('../src/server/browser.ts');
/**
 * DECLARED DEVIATIONS — every place a mirrored row is not the live row, printed
 * at the end so a reader is never left to assume fidelity that was not there.
 */
const deviations: string[] = [];

/** Mirror one live row into the isolated registry under a distinct id. */
function mirror(row: Record<string, unknown>, suffix = 'f96'): ReturnType<typeof reg.createProject> {
  const settings = { ...(row.settings as Record<string, unknown>) };
  /*
   * The stealth browser is unrelated to the tool profile, but a project with
   * `browser.enabled` REFUSES to start a session at all when the adapter is not
   * configured (`agent-bridge.ts` — "handing back a session silently missing
   * the browser the user enabled just moves the failure to mid-task"). All
   * three containerised projects here enable it. Rather than report six
   * profile failures that are really one missing optional integration, the
   * mirror turns the browser off for the run and SAYS SO.
   */
  const wantsBrowser = (settings.browser as { enabled?: boolean } | undefined)?.enabled === true;
  if (wantsBrowser && !browser.available().ok) {
    settings.browser = { ...(settings.browser as object), enabled: false };
    deviations.push(`${row.id}: browser disabled for this run — the adapter is not configured on this machine, and a browser-enabled project refuses to start a session without it. Unrelated to the profile.`);
  }
  const p = reg.createProject({
    name: `${suffix}-${row.id as string}`,
    hostPath: row.hostPath as string,
    isolation: row.isolation as never,
    // Otherwise the row's REAL settings, so a container project is
    // containerised here for the same reason it is there.
    settings: settings as never,
  } as never);
  return p;
}

interface Seen {
  tools: { name: string; input: unknown; agentId: string | null }[];
  results: { preview: string; agentId: string | null; isError: boolean }[];
  text: { text: string; agentId: string | null }[];
  errors: string[];
  ended: boolean;
}

/** Run ONE real turn against a mirrored project and collect what happened. */
async function runTurn(project: ReturnType<typeof reg.createProject>, prompt: string, label: string, budgetMs = 300_000): Promise<Seen> {
  const seen: Seen = { tools: [], results: [], text: [], errors: [], ended: false };
  let resolveEnd: () => void = () => {};
  const done = new Promise<void>((r) => { resolveEnd = r; });
  const onEvent = (e: StationEvent) => {
    if (e.t === 'tool-call') seen.tools.push({ name: e.name as string, input: e.input, agentId: (e.agentId as string) ?? null });
    if (e.t === 'tool-result') seen.results.push({ preview: String(e.preview ?? ''), agentId: (e.agentId as string) ?? null, isError: e.isError === true });
    if (e.t === 'text') seen.text.push({ text: String(e.text ?? ''), agentId: (e.agentId as string) ?? null });
    if (e.t === 'error') { seen.errors.push(String(e.message ?? '')); if (e.fatal) resolveEnd(); }
    if (e.t === 'turn-end') { seen.ended = true; resolveEnd(); }
  };
  console.log(`\n─── ${label} ───`);
  let session: Awaited<ReturnType<typeof startSession>> | null = null;
  const timer = setTimeout(resolveEnd, budgetMs);
  try {
    session = await startSession({ project, firstPrompt: prompt, onEvent } as never);
    await done;
  } catch (err) {
    seen.errors.push((err as Error).message);
  } finally {
    clearTimeout(timer);
    if (session) await session.close('verifier done').catch(() => {});
  }
  console.log(`  main-thread tools: ${seen.tools.filter((t) => !t.agentId).map((t) => t.name).join(', ') || '(none)'}`);
  for (const t of seen.tools.filter((x) => !x.agentId && x.name === 'Bash')) {
    console.log(`    main Bash: ${String((t.input as { command?: string })?.command ?? '').replace(/\n/g, ' ⏎ ').slice(0, 300)}`);
  }
  console.log(`  lane tools:        ${seen.tools.filter((t) => t.agentId).map((t) => t.name).join(', ') || '(none)'}`);
  if (seen.errors.length) console.log(`  errors: ${seen.errors.join(' | ').slice(0, 400)}`);
  const reply = seen.text.filter((t) => !t.agentId).map((t) => t.text).join('\n').trim();
  console.log(`  reply: ${reply.slice(0, 500).replace(/\n/g, ' ')}`);
  return seen;
}

const DENIAL = /Orchestrator tool profile/;
const denialReached = (s: Seen) => s.results.some((r) => !r.agentId && DENIAL.test(r.preview));

/*
 * THE DRIFT PROMPT. Deliberately the shape that produced the complaint: work a
 * session would previously have opened with a shell command. It is bounded (one
 * directory listing) so it costs one cheap lane on any project, including the
 * home directory.
 */
const DRIFT_PROMPT =
  'How many top-level entries are in this project directory, and name three of them? '
  + 'Find out by running a shell command.';

/* ─────────────────────────── A. LIVE-SESSION IMMUNITY ─────────────────────── */
/*
 * The question that gated enabling this for Orchard's own project: does turning
 * the profile on disturb a session that is ALREADY RUNNING? The profile is
 * composed once, in `startSession`, and handed to `runtime.start()`; the
 * project PATCH route writes the registry and touches no live session. That is
 * an argument. This is the test.
 */
if (flag('immunity') || flag('all')) {
  const orchardRow = live.projects.find((p) => (p.hostPath as string).endsWith('/orchard')) ?? live.projects[0];
  const p = mirror({ ...orchardRow, settings: { ...(orchardRow.settings as object), orchestratorProfile: { enabled: false } } }, 'imm');
  console.log(`\n═══ A. live-session immunity (mirroring ${orchardRow.id}, starting with the profile OFF) ═══`);

  const seen: Seen = { tools: [], results: [], text: [], errors: [], ended: false };
  let resolveEnd: () => void = () => {};
  let done = new Promise<void>((r) => { resolveEnd = r; });
  const onEvent = (e: StationEvent) => {
    if (e.t === 'tool-call') seen.tools.push({ name: e.name as string, input: e.input, agentId: (e.agentId as string) ?? null });
    if (e.t === 'tool-result') seen.results.push({ preview: String(e.preview ?? ''), agentId: (e.agentId as string) ?? null, isError: e.isError === true });
    if (e.t === 'text') seen.text.push({ text: String(e.text ?? ''), agentId: (e.agentId as string) ?? null });
    if (e.t === 'error') { seen.errors.push(String(e.message ?? '')); if (e.fatal) resolveEnd(); }
    if (e.t === 'turn-end') resolveEnd();
  };
  const session = await startSession({ project: p, firstPrompt: 'Run the shell command `echo TURN_ONE_OK` and report its exact output.', onEvent } as never);
  await done;
  const turnOneTools = seen.tools.length;
  check('A1: with the profile OFF the live session runs its own shell (the baseline)',
    seen.tools.some((t) => !t.agentId && t.name === 'Bash'));

  // THE CHANGE, mid-session, through the real registry writer.
  reg.updateProject(p.id, validateProjectPatch({ orchestratorProfile: { enabled: true } }) as never);
  check('A2: the registry now says enabled for the project this live session belongs to',
    reg.orchestratorProfileOf(reg.getProject(p.id)!).enabled === true);

  // …and the SAME session takes another turn.
  done = new Promise<void>((r) => { resolveEnd = r; });
  await session.send('Now run the shell command `echo TURN_TWO_OK` and report its exact output.');
  await done;
  const turnTwo = seen.tools.slice(turnOneTools);
  check('A3: the ALREADY-RUNNING session still has its shell after the flip (enabling does not reach into a live session)',
    turnTwo.some((t) => !t.agentId && t.name === 'Bash'));
  check('A4: …and no denial was delivered to it',
    !seen.results.slice(0).some((r) => DENIAL.test(r.preview)));
  check('A5: …and it produced the output',
    /TURN_TWO_OK/.test(seen.results.map((r) => r.preview).join('') + seen.text.map((t) => t.text).join('')));
  await session.close('immunity done').catch(() => {});

  // A NEW session in the same, now-enabled project IS enforced.
  const fresh = await runTurn(reg.getProject(p.id)!, DRIFT_PROMPT, 'A6. a NEW session in the same project — must be enforced');
  check('A6: a session launched AFTER the flip is enforced (the change lands on the next launch)', denialReached(fresh));
}

/* ─────────────────────── B. PER-PROJECT, REAL SESSIONS ────────────────────── */
if (flag('projects') || flag('all')) {
  const want = value('projects').split(',').map((s) => s.trim()).filter(Boolean);
  const rows = flag('all') && !want.length ? live.projects : live.projects.filter((p) => want.includes(p.id as string));
  if (!rows.length) { console.log('no matching projects'); process.exit(2); }

  for (const row of rows) {
    const id = row.id as string;
    if (!fs.existsSync(row.hostPath as string)) { console.log(`\n─── SKIP ${id}: ${row.hostPath} is gone ───`); continue; }
    console.log(`\n═══ B. ${id} (${row.isolation}) — ${row.hostPath} ═══`);
    const p = mirror(row);
    check(`${id}: mirrored row carries the enabled profile`, reg.orchestratorProfileOf(reg.getProject(p.id)!).enabled === true);

    // B1 + B2 + the drift observation, in one real turn.
    const s = await runTurn(p, DRIFT_PROMPT, `${id} — the drift prompt`);
    check(`${id}: the orchestrating session's own shell call was DENIED, with the reason delivered`, denialReached(s));
    check(`${id}: the refusal names the way through (dispatch), not just "no"`,
      s.results.some((r) => !r.agentId && /Agent tool/.test(r.preview)));
    check(`${id}: it DISPATCHED instead of stalling — the drift is gone`,
      s.tools.some((t) => !t.agentId && t.name === 'Agent'));
    check(`${id}: the dispatched lane kept its full toolset (it ran the shell itself)`,
      s.tools.some((t) => !!t.agentId && t.name === 'Bash'));
    check(`${id}: the work still got done`, s.text.some((t) => !t.agentId && t.text.trim().length > 40));
    check(`${id}: nothing was written into the project tree`,
      !fs.existsSync(path.join(row.hostPath as string, '.claude', 'hooks', 'orchestrator-surface-log.mjs')));

    // B3 — a question needing no tools is answered normally.
    const q = await runTurn(p, 'Without using any tool at all, answer in one sentence: what is 17 multiplied by 23?', `${id} — no-tool question`, 120_000);
    check(`${id}: a no-tool question is answered normally`, q.tools.length === 0 && /391/.test(q.text.map((t) => t.text).join('')));
  }
}

if (!flag('immunity') && !flag('projects') && !flag('all')) {
  console.log('nothing to do — pass --immunity, --projects=a,b or --all');
  process.exit(2);
}

const failed = checks.filter((c) => !c.ok);
if (deviations.length) {
  console.log('\nDECLARED DEVIATIONS from the live rows (read these before trusting the result):');
  for (const d of deviations) console.log(`  · ${d}`);
}
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} — ${checks.length - failed.length}/${checks.length}`);
for (const c of failed) console.log(`  FAILED: ${c.name}`);
console.log(`(isolated data dir: ${isolated})`);
process.exit(failed.length === 0 ? 0 : 1);
