#!/usr/bin/env node
/**
 * FEAT-043 — provider-routed one-shot task dispatch (mixed Claude + GPT fleet, v1).
 *
 * A Claude orchestrator's Task-tool subagents are in-process Claude and can
 * never be GPT — so the mixed fleet's dispatch unit is ORCHARD-level: any
 * orchestrator session invokes THIS script via Bash to drive one task through
 * the other provider and consume the result. Routing guidance (which provider
 * for which task) lives in docs/prompts/ROUTING.md (canonical:
 * ~/projects/methodology/ROUTING.md).
 *
 *   node scripts/dispatch.mjs --provider openai   [--model <m>] [--cwd <dir>]
 *                             [--sandbox read-only|workspace-write]
 *                             [--timeout-min <n>] "task prompt"
 *   node scripts/dispatch.mjs --provider anthropic [--model <m>] [--cwd <dir>] "task prompt"
 *
 * Contract (machine-consumable):
 *   stdout  = the FINAL RESULT text only (the last assistant message).
 *   stderr  = progress: thread id, streamed deltas, tool activity, errors.
 *   exit 0  = success; nonzero = failure, with the BUG-031 taxonomy kind named
 *             on stderr as `dispatch failed [<kind>] …` (quota-window,
 *             auth-expired, rate-limited, overloaded, model-unavailable,
 *             network, internal; transport/timeout for non-turn failures).
 *
 * --provider openai drives the REAL CodexRuntime (src/server/runtime/
 * codex-runtime.ts): binary via detection / CLAUDE_STATION_CODEX_BIN (the
 * fixture seam), subscription OAuth only. SAFE DEFAULTS: sandbox read-only +
 * approvalPolicy 'never' (headless — nobody can answer a prompt; the sandbox
 * is the wall). `--sandbox workspace-write` opts into in-workspace writes.
 * Every run is recorded into the Orchard transcript store
 * (dataDir()/transcripts/openai/…, src/server/orchard-transcripts.ts) so
 * dispatches are auditable in the dashboard's history like any Codex session.
 *
 * --provider anthropic delegates to `claude -p --output-format json` (the
 * CLI persists its own transcript store, so history needs no recorder here).
 * v1-hardening (FEAT-043 live cross-provider review, 2026-08-05):
 *   - `--timeout-min` IS enforced: on expiry the `claude` process GROUP is
 *     killed (SIGTERM then SIGKILL grace), exit is nonzero, and the
 *     `dispatch failed [timeout] …` line is named — same contract as openai.
 *   - `--sandbox` IS translated, honestly, to Claude Code's own permission
 *     gate: read-only (default) => `--permission-mode plan` +
 *     `--disallowedTools Edit,Write,NotebookEdit` (belt-and-suspenders: plan
 *     mode alone never executes writes headless since nothing can approve
 *     exiting it, and the disallow-list is a hard backstop). workspace-write
 *     => `--permission-mode acceptEdits` (writes auto-approved, confined to
 *     cwd/--add-dir by Claude's own path allow-list).
 *     HONEST BOUNDARY (documented, not faked): this is an APPLICATION-LEVEL
 *     gate inside the `claude` process, not an OS-level filesystem jail like
 *     Codex's `sandbox_mode` on the openai path — a compromised/adversarial
 *     model run this way is confined by Claude's own tool-permission logic,
 *     not by kernel-enforced isolation. If a true FS sandbox is needed for
 *     the anthropic path, wrap this script's `claude` invocation in an
 *     external sandboxing layer (bwrap/firejail/container) — out of scope
 *     here (architectural, tracked in the FEAT-043 ticket).
 *   - Failures ARE classified into the BUG-031 taxonomy: `--output-format
 *     json` gives a structured `{is_error, api_error_status, result}` (no
 *     streaming — one JSON blob per turn, a known coarseness vs the openai
 *     path's rich stderr progress; also tracked as a documented limitation),
 *     mapped by status code / result text via `classifyAnthropicError()`
 *     below (mirrors claude-runtime.ts's ASSISTANT_ERROR_MAP kinds).
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  formatDispatchDeclaration,
  parseDispatchDeclaration,
  DECLARED_PHASES,
  DISPATCH_CLASSES,
} from './lib/cost-model.mjs';
// A dispatched lane is an AGENT-started session by construction — this script
// only ever runs because an orchestrator invoked it. Declare that provenance at
// creation so the picker can fold these rows out of the human's way (they are
// still reachable by URL/search/"N more"). Best-effort and never fatal.
import { recordSessionProvenance } from '../src/lib/session-provenance.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const USAGE = `usage: node scripts/dispatch.mjs --provider openai|anthropic [--model <m>] [--cwd <dir>] [--sandbox read-only|workspace-write] [--timeout-min <n>] [--allow-tools "Bash Read Write"] [--resume <session-id>] [--meta-out <file>] [--prompt-stdin] [--ticket <ID>] [--phase finding|fixing|verifying] [--round <n>] [--class trivial|fix|explore|plan+review|arch|verify] "task prompt"`;

const HELP = `${USAGE}

--sandbox read-only (default) | workspace-write
  openai:     Codex OS-level sandbox_mode (kernel-enforced write jail).
  anthropic:  Claude Code's own permission-mode gate (--permission-mode
              plan+disallowedTools for read-only, acceptEdits for
              workspace-write) — an APPLICATION-level gate, not an OS
              filesystem jail. Honest boundary: a compromised model on the
              anthropic path is confined by Claude's tool-permission logic,
              not kernel isolation. Use the openai path (or wrap this
              script's \`claude\` invocation in an external sandbox) if a
              true FS jail is required.

--timeout-min <n> (default 15)
  Enforced on BOTH providers: on expiry the child process (group) is killed
  by pid/process-group and the run exits nonzero with
  \`dispatch failed [timeout] …\` on stderr.

--resume <session-id> (FEAT-062: the durable-fixer primitive)
  anthropic only: continue an existing \`claude\` session (\`claude -p --resume\`)
  so a fixer thread keeps its accumulated context across verify rounds. The
  openai path has no equivalent surface here and refuses honestly.

--meta-out <file> (FEAT-062, review finding #11: session-id scraping from
  human-oriented stderr is a fragile protocol)
  write machine-readable run metadata as JSON:
  { provider, model, sessionId, exitCode, failureKind } — the durable channel
  a caller resumes from. Written on failure too (sessionId may be null).

--prompt-stdin (FEAT-062 closing finding 5, 2026-08-11: spawn E2BIG)
  read the task prompt from stdin instead of argv. Linux caps a single argv
  string at MAX_ARG_STRLEN (131072 bytes), so a large prompt (e.g. a big
  verification diff) passed positionally kills the spawn with E2BIG. With
  this flag the prompt travels over stdin end-to-end: into this script AND
  into \`claude -p\` (which reads its prompt from stdin when none is given
  positionally). The openai path already hands the prompt to the Codex
  app-server over its protocol, not argv. Mutually exclusive with a
  positional prompt.

--ticket <ID[,ID]> --phase finding|fixing|verifying --round <n>
--class trivial|fix|explore|plan+review|arch|verify   (FEAT-100)
  Declare what this dispatch IS, at the moment it is dispatched. Emits one
  canonical line at the top of the prompt —
      Dispatch: ticket=BUG-099 phase=fixing round=2 class=fix
  — which lands in the run's transcript, where \`npm run cost:collect\` reads it
  back through the SAME grammar module (scripts/lib/cost-model.mjs). That is
  what makes per-ticket cost and a finding/fixing/verifying split real instead
  of re-derived from prose and tool use. Costs nothing at runtime: it is a
  string concatenation of values already in argv. Omit any of them and the
  field is recorded as ABSENT — never guessed. Also written to --meta-out.

Exit taxonomy (both providers, stderr): \`dispatch failed [<kind>] …\` where
kind is one of quota-window, auth-expired, rate-limited, overloaded,
model-unavailable, network, internal, timeout, transport.`;

function die(msg, code = 2) {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

/* ------------------------------------------------------------------ args */

const argv = process.argv.slice(2);
const opts = { provider: null, model: null, cwd: process.cwd(), sandbox: 'read-only', timeoutMin: 15, allowTools: null, resume: null, metaOut: null, promptStdin: false, ticket: null, phase: null, round: null, dispatchClass: null };
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const take = () => {
    if (i + 1 >= argv.length) die(`${a} needs a value\n${USAGE}`);
    return argv[++i];
  };
  if (a === '--provider') opts.provider = take();
  else if (a === '--model') opts.model = take();
  else if (a === '--cwd') opts.cwd = path.resolve(take());
  else if (a === '--sandbox') opts.sandbox = take();
  else if (a === '--timeout-min') opts.timeoutMin = Number(take());
  else if (a === '--allow-tools') opts.allowTools = take();
  else if (a === '--resume') opts.resume = take();
  else if (a === '--meta-out') opts.metaOut = path.resolve(take());
  else if (a === '--prompt-stdin') opts.promptStdin = true;
  // FEAT-100: the four facts the dispatcher already knows. Declared, not inferred.
  else if (a === '--ticket') opts.ticket = take();
  else if (a === '--phase') opts.phase = take();
  else if (a === '--round') opts.round = take();
  else if (a === '--class') opts.dispatchClass = take();
  else if (a === '--help' || a === '-h') { console.log(HELP); process.exit(0); }
  else if (a === '--') { positional.push(...argv.slice(i + 1)); break; } // end of options: rest is prompt text
  else if (a.startsWith('--')) die(`unknown flag ${a}\n${USAGE}`);
  else positional.push(a);
}
let task = positional.join(' ').trim();
if (opts.promptStdin) {
  // FEAT-062 closing finding 5: the E2BIG-proof channel. The prompt arrives on
  // stdin, never as an argv element (MAX_ARG_STRLEN caps one argv string at
  // 131072 bytes on Linux).
  if (task) die(`--prompt-stdin and a positional prompt are mutually exclusive\n${USAGE}`);
  try { task = fs.readFileSync(0, 'utf8').trim(); } catch (e) { die(`--prompt-stdin: could not read stdin — ${e.message}`); }
}
if (!task) die(`no task prompt given\n${USAGE}`);
if (opts.provider !== 'openai' && opts.provider !== 'anthropic') {
  die(`--provider must be 'openai' or 'anthropic' (got ${JSON.stringify(opts.provider)})\n${USAGE}`);
}
if (opts.sandbox !== 'read-only' && opts.sandbox !== 'workspace-write') {
  die(`--sandbox must be 'read-only' or 'workspace-write' (got ${JSON.stringify(opts.sandbox)})\n${USAGE}`);
}
if (!Number.isFinite(opts.timeoutMin) || opts.timeoutMin <= 0) die('--timeout-min must be a positive number');
if (opts.resume && opts.provider !== 'anthropic') {
  die('--resume is only supported on the anthropic path (claude -p --resume); the openai path has no session-resume surface here');
}

const progress = (msg) => process.stderr.write(`[dispatch] ${msg}\n`);

/* ------------------------------------------------- FEAT-100: the declaration */

/**
 * Record what this dispatch IS, at the boundary where it is known.
 *
 * The cost ledger could previously answer "what did this lane cost" but not
 * "what was it for" — ticket came from regexing prose, lifecycle phase was
 * substituted from tool use (a different axis entirely), round came from a
 * lane's position in a sorted list, and the dispatch class the Working
 * Agreement requires was nowhere at all. All four are known HERE.
 *
 * The channel is one line prepended to the prompt, because the prompt is
 * already being written and already lands in the transcript the collector
 * already reads. No store, no extra write, no runtime call — this is a string
 * concatenation of facts that are sitting in argv.
 *
 * The line is FORMATTED and then PARSED BACK by the same module the collector
 * uses. If it does not round-trip, the dispatch is refused before anything
 * spawns: emitting a declaration the reader cannot read would be worse than
 * emitting none, because it looks like a record.
 */
const declaration = (() => {
  if (!opts.ticket && !opts.phase && !opts.round && !opts.dispatchClass) return null;
  if (opts.phase && !DECLARED_PHASES.includes(opts.phase)) {
    die(`--phase must be one of ${DECLARED_PHASES.join(' | ')} (got ${JSON.stringify(opts.phase)})`);
  }
  if (opts.dispatchClass && !DISPATCH_CLASSES.includes(opts.dispatchClass)) {
    die(`--class must be one of ${DISPATCH_CLASSES.join(' | ')} (got ${JSON.stringify(opts.dispatchClass)})`);
  }
  const line = formatDispatchDeclaration({
    ticket: opts.ticket, phase: opts.phase, round: opts.round, class: opts.dispatchClass,
  });
  const back = parseDispatchDeclaration(line);
  const asked = { ticket: opts.ticket, phase: opts.phase, round: opts.round, class: opts.dispatchClass };
  if (back.rejected.length || back.malformed.length || back.unknown_keys.length) {
    die(`--ticket/--phase/--round/--class did not round-trip through the shared grammar: ${[...back.rejected, ...back.malformed.map((t) => `malformed token ${t}`)].join('; ')}\n  line was: ${line}`);
  }
  for (const [k, v] of Object.entries(asked)) {
    if (v == null) continue;
    const got = k === 'ticket' ? (back.tickets ?? []).join(',') : String(back[k] ?? '');
    if (got !== String(v)) die(`--${k}=${v} did not round-trip (read back as ${JSON.stringify(got)})\n  line was: ${line}`);
  }
  return { line, fields: { ticket: back.tickets, phase: back.phase, round: back.round, class: back.class } };
})();

if (declaration) {
  task = `${declaration.line}\n\n${task}`;
  progress(declaration.line);
}

/**
 * FEAT-062 (review finding #11): the machine-readable metadata channel. The
 * human-oriented stderr lines (`session <id>`, `thread <id> started`) stay,
 * but a caller that must RESUME a session gets a JSON file instead of a regex
 * over progress text. Best-effort write, never fatal — the dispatch result is
 * the primary contract.
 */
function writeMeta({ sessionId = null, exitCode, failureKind = null }) {
  if (!opts.metaOut) return;
  try {
    fs.writeFileSync(opts.metaOut, JSON.stringify({
      provider: opts.provider, model: opts.model ?? null,
      sessionId, exitCode, failureKind, resumed: Boolean(opts.resume), ts: new Date().toISOString(),
      // FEAT-100: null, not omitted, when nothing was declared — a caller can
      // then tell "this dispatch declared nothing" from "this meta file is old".
      dispatch: declaration ? declaration.fields : null,
    }, null, 2) + '\n');
  } catch (e) { progress(`meta-out not written: ${e.message}`); }
}

/* ------------------------------------------------- anthropic: thin claude -p */

if (opts.provider === 'anthropic') {
  await dispatchAnthropic();
} else {
  await dispatchOpenai();
}

/* ------------------------------------------------- anthropic: claude -p */

/**
 * BUG-031 taxonomy classifier for the anthropic dispatch path. `claude -p
 * --output-format json` gives a single structured result blob (no `error:`
 * discriminant string like the SDK stream carries — see claude-runtime.ts's
 * ASSISTANT_ERROR_MAP — so this classifies from `api_error_status` +
 * `result` text instead). Pure function; mirrors the SDK path's kinds.
 */
function classifyAnthropicError(result) {
  const status = result.api_error_status ?? null;
  const text = String(result.result ?? '');
  if (status === 529) return { kind: 'overloaded', retryable: true };
  if (/usage limit|quota exceeded|weekly limit|5-hour limit|billing/i.test(text)) {
    return { kind: 'quota-window', retryable: false };
  }
  if (status === 429 || /rate limit/i.test(text)) return { kind: 'rate-limited', retryable: true };
  if (status === 401 || status === 403 || /authentication|not logged in|credentials expired|please (log|sign) in/i.test(text)) {
    return { kind: 'auth-expired', retryable: false };
  }
  if (status === 404 || /model.*(not exist|not found|no access|unavailable)/i.test(text)) {
    return { kind: 'model-unavailable', retryable: false };
  }
  if (typeof status === 'number' && status >= 500) return { kind: 'internal', retryable: true };
  return { kind: 'internal', retryable: false };
}

async function dispatchAnthropic() {
  // --prompt-stdin: `claude -p` with no positional prompt reads the prompt
  // from stdin — the E2BIG-proof handoff (a >131072-byte argv element kills
  // the spawn on Linux before claude ever runs).
  const args = opts.promptStdin ? ['-p', '--output-format', 'json'] : ['-p', task, '--output-format', 'json'];
  if (opts.resume) args.push('--resume', opts.resume); // FEAT-062: continue an existing session (durable fixer thread)
  if (opts.model) args.push('--model', opts.model);
  // FEAT-043 v1-hardening: honest --sandbox translation (see header note).
  if (opts.sandbox === 'read-only') {
    args.push('--permission-mode', 'plan', '--disallowedTools', 'Edit,Write,NotebookEdit');
  } else {
    args.push('--permission-mode', 'acceptEdits');
  }
  // FEAT-061: `acceptEdits` auto-approves Edit/Write but NOT Bash, so a headless
  // run that must EXECUTE something (an independent verifier producing real test
  // output) silently produced "could not be run in non-interactive mode" instead
  // of evidence. --allow-tools is the explicit, opt-in allowlist for that case;
  // it is never implied by --sandbox, so nothing else changes behavior.
  if (opts.allowTools) args.push('--allowedTools', ...opts.allowTools.split(/[,\s]+/).filter(Boolean));
  progress(`claude -p (model ${opts.model ?? 'default'}, cwd ${opts.cwd}, sandbox ${opts.sandbox} [application-level gate, not an OS jail]${opts.allowTools ? `, allow-tools ${opts.allowTools}` : ''})`);

  const child = spawn('claude', args, { cwd: opts.cwd, stdio: [opts.promptStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'], detached: true });
  if (opts.promptStdin) {
    child.stdin.on('error', () => { /* EPIPE if claude dies early; the exit handler reports */ });
    child.stdin.end(task);
  }

  let stdoutBuf = '';
  let stderrBuf = '';
  // BUG-078: setEncoding('utf8') so a multibyte codepoint whose bytes straddle
  // two stdout chunks is decoded whole (Node's StringDecoder buffers the
  // partial bytes). A raw `stdoutBuf += d` coerces each Buffer chunk on its
  // own, decoding the split codepoint to U+FFFD in each half — the JSON parses
  // fine (structural bytes are ASCII) but the `result` text is corrupted.
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { stdoutBuf += d; });
  child.stderr.on('data', (d) => { stderrBuf += d; process.stderr.write(d); }); // pass through as progress

  let timedOut = false;
  const killGroup = (sig) => {
    try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* already gone */ } }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    progress(`dispatch failed [timeout]: no completion within ${opts.timeoutMin} min — killing process group`);
    killGroup('SIGTERM');
    setTimeout(() => killGroup('SIGKILL'), 3_000).unref?.();
  }, opts.timeoutMin * 60_000);
  timer.unref?.();
  process.on('SIGINT', () => { progress('interrupted (SIGINT)'); killGroup('SIGINT'); process.exit(130); });

  child.once('error', (err) => {
    clearTimeout(timer);
    // `--meta-out` documents "written on failure too", and this path — the spawn
    // itself failing — was the one exit that did not honour it. Found by the
    // FEAT-100 suite; it matters more now, because the meta file is where a
    // caller reads back what the dispatch DECLARED, and a dispatch that never
    // started is exactly when a caller needs to know what it was going to be.
    writeMeta({ exitCode: 1, failureKind: 'transport' });
    die(`dispatch failed [transport] (provider anthropic): claude CLI not runnable — ${err.message}`, 1);
  });

  child.once('exit', (code) => {
    clearTimeout(timer);
    if (timedOut) { writeMeta({ exitCode: 1, failureKind: 'timeout' }); process.exit(1); }

    let parsed = null;
    try { parsed = JSON.parse(stdoutBuf); } catch { /* not JSON — handled below */ }
    // Provenance is declared the moment the session id is known — on success OR
    // failure, since a failed turn still wrote a row into the store.
    if (parsed && typeof parsed.session_id === 'string') {
      recordSessionProvenance(parsed.session_id, 'agent', { source: 'dispatch:anthropic' });
    }
    if (!parsed) {
      progress(`dispatch failed [transport] (provider anthropic): unparseable output (exit ${code}) — ${(stdoutBuf || stderrBuf || 'no output').slice(0, 200)}`);
      writeMeta({ exitCode: 1, failureKind: 'transport' });
      process.exit(1);
      return;
    }
    if (parsed.is_error) {
      const pe = classifyAnthropicError(parsed);
      progress(`dispatch failed [${pe.kind}] (provider anthropic${pe.retryable ? ', retryable' : ''}): ${parsed.result ?? 'turn failed'}`);
      writeMeta({ sessionId: parsed.session_id ?? null, exitCode: 1, failureKind: pe.kind });
      process.exit(1);
      return;
    }
    const text = typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed.result ?? '');
    // FEAT-061: name the run. A verification must be traceable to a DISPATCH
    // (that is what a `Verified-by:` line cites, and what an in-process Task
    // subagent can never produce) — so the id has to reach stderr like the
    // openai path's `thread … started` line.
    if (parsed.session_id) progress(`session ${parsed.session_id} (anthropic run id)`);
    if (parsed.usage) progress(`tokens: ${JSON.stringify(parsed.usage)}`);
    writeMeta({ sessionId: parsed.session_id ?? null, exitCode: code === 0 ? 0 : (code ?? 1) });
    process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
    process.exit(code === 0 ? 0 : (code ?? 1));
  });
}

/* --------------------------------------------------- openai: CodexRuntime */

async function dispatchOpenai() {
  const { CodexRuntime } = await import(path.join(ROOT, 'src', 'server', 'runtime', 'codex-runtime.ts'));
  const { TranscriptRecorder } = await import(path.join(ROOT, 'src', 'server', 'orchard-transcripts.ts'));

  const recorder = new TranscriptRecorder({
    provider: 'openai',
    cwd: opts.cwd,
    onError: (m) => progress(`transcript: ${m}`),
  });
  recorder.recordUserPrompt(task);

  const rt = new CodexRuntime();
  let exitCode = 1;
  let timedOut = false;
  let openaiSessionId = null;

  const timer = setTimeout(() => {
    timedOut = true;
    progress(`dispatch failed [timeout]: no completion within ${opts.timeoutMin} min — interrupting`);
    void rt.interrupt?.().catch(() => {});
    setTimeout(() => { rt.close(); }, 3_000).unref?.();
  }, opts.timeoutMin * 60_000);
  timer.unref?.();
  process.on('SIGINT', () => { progress('interrupted (SIGINT)'); rt.close(); process.exit(130); });

  rt.start({
    cwd: opts.cwd,
    firstPrompt: task,
    // FEAT-043 headless modes (codex-runtime.ts modeToCodex): approvals
    // 'never' + the sandbox as the wall. Default read-only; workspace-write
    // only when explicitly requested.
    permissionMode: `dispatch:${opts.sandbox}`,
    ...(opts.model ? { model: opts.model } : {}),
    onApproval: async () => ({ behavior: 'deny', message: 'headless dispatch: interactive approvals are unavailable' }),
  });

  /** Last assistant text message = the final result (Codex emits its answer
   *  as the turn's last agentMessage; interim ones stream to stderr anyway). */
  let finalText = null;
  let streamedDelta = false;

  try {
    for await (const m of rt.messages()) {
      if (m.type === 'system' && m.subtype === 'init') {
        recorder.adoptSessionId(String(m.session_id ?? ''));
        openaiSessionId = m.session_id ?? null;
        // Same as the anthropic path: a dispatched codex run is agent-started.
        if (typeof openaiSessionId === 'string') {
          recordSessionProvenance(openaiSessionId, 'agent', { source: 'dispatch:openai' });
        }
        recorder.setModel(opts.model ?? null);
        progress(`thread ${m.session_id} started (model ${opts.model ?? 'codex default'}, sandbox ${opts.sandbox}, cwd ${opts.cwd})`);
        continue;
      }
      if (m.type === 'stream_event') {
        const t = m.event?.delta?.text;
        if (t) { process.stderr.write(t); streamedDelta = true; }
        continue;
      }
      if (m.type === 'assistant' || m.type === 'user') {
        recorder.recordRuntimeMessage(m);
        const block = m.message?.content?.[0];
        if (m.type === 'assistant' && block?.type === 'text' && typeof block.text === 'string') {
          if (streamedDelta) { process.stderr.write('\n'); streamedDelta = false; }
          finalText = block.text;
        } else if (block?.type === 'tool_use') {
          progress(`tool ${block.name}: ${JSON.stringify(block.input ?? {}).slice(0, 200)}`);
        } else if (block?.type === 'tool_result') {
          progress(`tool result (${block.is_error ? 'error' : 'ok'})`);
        }
        continue;
      }
      if (m.type === 'result') {
        clearTimeout(timer);
        if (m.is_error) {
          const pe = rt.classifyProviderError?.(m) ?? null;
          const kind = timedOut ? 'timeout' : (pe?.kind ?? 'internal');
          progress(`dispatch failed [${kind}] (provider openai${pe?.retryable ? ', retryable' : ''}): ${pe?.detail ?? m.result ?? 'turn failed'}`);
          exitCode = 1;
        } else if (timedOut) {
          progress('dispatch failed [timeout]: turn was interrupted by the dispatch timeout');
          exitCode = 1;
        } else if (m.subtype === 'interrupted') {
          progress('dispatch failed [interrupted]: turn did not run to completion');
          exitCode = 1;
        } else if (finalText == null) {
          progress('dispatch failed [internal]: turn completed but produced no assistant message');
          exitCode = 1;
        } else {
          if (m.usage) progress(`tokens: ${JSON.stringify(m.usage)}`);
          process.stdout.write(finalText.endsWith('\n') ? finalText : `${finalText}\n`);
          exitCode = 0;
        }
        break; // one task = one turn; done either way
      }
    }
  } catch (err) {
    // Transport death (spawn ENOENT, app-server crash, protocol violation).
    clearTimeout(timer);
    progress(`dispatch failed [transport] (provider openai): ${err?.message ?? err}`);
    exitCode = 1;
  }

  rt.close();
  if (recorder.filePath) progress(`transcript: ${recorder.filePath}`);
  writeMeta({ sessionId: openaiSessionId, exitCode, failureKind: exitCode === 0 ? null : 'see stderr taxonomy line' });
  process.exit(exitCode);
}
