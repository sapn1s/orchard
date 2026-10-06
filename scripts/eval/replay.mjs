/**
 * replay.mjs — run ONE (model x prompt) cell of the FEAT-162 prompt competition.
 *
 * Builds a single batched, TEXT-ONLY prompt = <competing prompt> + the selected
 * frozen cases (context + user turn + output contract), dispatches it once via
 * scripts/dispatch.mjs (read-only, cwd = an empty scratch dir so no tool can
 * touch a real project), parses the reply per case, scores each mechanically
 * with scorers.mjs, and APPENDS one result row per case to --out (so partial
 * progress survives). Prints the cell's pass-rate.
 *
 *   node scripts/eval/replay.mjs --provider anthropic --model claude-opus-5-5 \
 *     --prompt docs/evals/prompts/baseline.md --split train --runs 2 \
 *     --label pilot --out docs/evals/results/pilot.jsonl
 *
 * --ids a,b,c  overrides --split with an explicit case list.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scoreCase } from './scorers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1]?.startsWith('--') || i + 1 >= process.argv.length ? true : process.argv[++i];
}
const provider = args.provider || 'anthropic';
const model = args.model || (provider === 'openai' ? 'codex-default' : 'claude-opus-5-5');
const runs = Number(args.runs || 1);
const label = args.label || 'run';
const promptFile = args.prompt;
const outFile = args.out ? path.resolve(ROOT, args.out) : path.resolve(ROOT, 'docs/evals/results/replay.jsonl');
const timeoutMin = Number(args['timeout-min'] || 12);

const cases = fs.readFileSync(path.resolve(ROOT, 'docs/evals/text-set.v2.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const byId = Object.fromEntries(cases.map((c) => [c.id, c]));
let ids;
if (args.ids) ids = String(args.ids).split(',').map((s) => s.trim());
else {
  const split = JSON.parse(fs.readFileSync(path.resolve(ROOT, 'docs/evals/split.v2.json'), 'utf8'));
  ids = args.split === 'test' ? split.test : args.split === 'all' ? [...split.train, ...split.test] : split.train;
}
const chosen = ids.map((id) => byId[id]).filter(Boolean);
const promptText = fs.readFileSync(path.resolve(ROOT, promptFile), 'utf8');

function buildPrompt() {
  const blocks = chosen.map((c) => (
    `=== CASE ${c.id} ===\n` +
    `CONTEXT: ${c.input.context}\n` +
    `USER: ${c.input.user_turn}\n` +
    `OUTPUT CONTRACT: ${c.input.output_contract}`
  )).join('\n\n');
  return (
    `${promptText}\n\n` +
    `----------------------------------------------------------------\n` +
    `You will now handle ${chosen.length} INDEPENDENT cases. They are unrelated; treat each fresh. ` +
    `Do NOT use any tools — answer from the text of each case alone. For each case, read its CONTEXT and ` +
    `the USER message, then respond following that case's OUTPUT CONTRACT exactly. Echo the case header ` +
    `line \`=== CASE <id> ===\` before each answer, in the same order.\n\n${blocks}\n`
  );
}

function dispatch(prompt) {
  const scratch = fs.mkdtempSync(path.join(process.env.CLAUDE_STATION_TMPDIR || os.tmpdir(), 'replay-'));
  const metaOut = path.join(scratch, 'meta.json');
  const dargs = ['scripts/dispatch.mjs', '--provider', provider, '--sandbox', 'read-only',
    '--cwd', scratch, '--prompt-stdin', '--meta-out', metaOut, '--timeout-min', String(timeoutMin),
    '--ticket', 'FEAT-162', '--phase', 'verifying', '--class', 'verify'];
  if (provider === 'anthropic') { dargs.push('--model', model); dargs.push('--tool-profile', 'monitor'); }
  else if (model && model !== 'codex-default') dargs.push('--model', model);
  const r = spawnSync(process.execPath, dargs, { cwd: ROOT, input: prompt, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let usage = null; try { usage = JSON.parse(fs.readFileSync(metaOut, 'utf8')).usage; } catch { /* */ }
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* */ }
  return { ok: r.status === 0, reply: r.stdout || '', err: (r.stderr || '').slice(-400), usage };
}

function segment(reply, id, nextId) {
  const start = reply.indexOf(`CASE ${id}`);
  if (start === -1) return null;
  let end = reply.length;
  if (nextId) { const n = reply.indexOf(`CASE ${nextId}`, start + 1); if (n !== -1) end = n; }
  return reply.slice(start, end);
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
let totPass = 0, totN = 0;
const perFamily = {};
for (let run = 1; run <= runs; run++) {
  const prompt = buildPrompt();
  const { ok, reply, err, usage } = dispatch(prompt);
  if (!ok) { process.stderr.write(`[replay] cell FAILED model=${model} prompt=${path.basename(promptFile)} run=${run}: ${err}\n`); continue; }
  for (let i = 0; i < chosen.length; i++) {
    const c = chosen[i];
    const seg = segment(reply, c.id, chosen[i + 1]?.id) || reply; // fall back to whole reply
    const res = scoreCase(c, seg);
    totN++; if (res.pass) totPass++;
    const fam = c.family; perFamily[fam] = perFamily[fam] || { pass: 0, n: 0 }; perFamily[fam].n++; if (res.pass) perFamily[fam].pass++;
    fs.appendFileSync(outFile, JSON.stringify({
      ts: new Date().toISOString(), label, provider, model, prompt: path.basename(promptFile),
      run, id: c.id, family: c.family, control: !!c.is_positive_control, pass: res.pass,
      observed: res.observed, usage: run === 1 && i === 0 ? usage : undefined,
    }) + '\n');
  }
  process.stderr.write(`[replay] run ${run}/${runs} done (${model} / ${path.basename(promptFile)}) usage=${usage ? usage.totalTokens : '?'}\n`);
}
const rate = totN ? (100 * totPass / totN).toFixed(1) : 'n/a';
process.stdout.write(`CELL ${label} model=${model} prompt=${path.basename(promptFile)} split=${args.split || 'ids'} n=${totN} pass=${totPass} rate=${rate}%\n`);
for (const [f, v] of Object.entries(perFamily)) process.stdout.write(`   ${f}: ${v.pass}/${v.n}\n`);
