/**
 * reach-tags.mjs — FEAT-208 (ADVISORY ONLY): the verifier tags every finding REACHABLE or
 * UNREACHABLE, with a one-line justification, against the project's threat model (real users
 * plus a careless, non-malicious agent — not crafted inputs). The tags are STORED and COUNTED,
 * nothing more.
 *
 * THE INVARIANT: a tag never changes a verdict, a ticket's verification state or its closure.
 * Nothing in this module returns a verdict word, and no proof reader (verification-source,
 * ticket-record, board-tool, candidate-store) imports it. The 2026-11-20 rescope removed the
 * design where an UNREACHABLE label turned a BROKEN into a residual: labels must first show they
 * predict anything (the 2026-12-04 read: `node scripts/reach-report.mjs`) before they may move
 * state. `npm run verify:feat-208` proves a tagged verdict leaves the ticket byte-identical to
 * the same verdict untagged.
 *
 * Grammar, one FINDING line (the tag rides in the finding's own speech, so the verdict contract
 * and its parsers see an ordinary FINDING line):
 *
 *   FINDING: <defect> || REACH: REACHABLE || WHY: <who or what produces this input in real use>
 *   FINDING: <defect> || REACH: UNREACHABLE || WHY: <why nothing in real use produces it>
 *
 * A finding with no tag, or a malformed one, is counted as `untagged` — never guessed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const REACH_SCHEMA = 'orchard-reach-tags/1';
export const REACH_VALUES = ['REACHABLE', 'UNREACHABLE', 'untagged'];

/** The prompt block independent-verify appends after the citation contract. */
export const REACH_RULE = `REACHABILITY TAG (advisory — it is recorded and counted, and it does NOT change
your verdict or how it is judged): end EVERY FINDING line with a reach tag:
FINDING: <defect> || REACH: REACHABLE || WHY: <who or what produces this input in real use>
FINDING: <defect> || REACH: UNREACHABLE || WHY: <why nothing in real use produces it>
Threat model: ordinary use by the user, plus a careless or habitual, NON-malicious agent
(retries, copied commands, stale state, interrupted runs, concurrent sessions). REACHABLE means
one of those can produce the input. UNREACHABLE means only hand-crafted input, fault injection,
forged objects or a deliberately malicious actor can. Judge honestly either way: the verdict is
yours alone — a BROKEN stays BROKEN whatever the tag says.`;

const TAG_RE = /\s*\|\|\s*REACH:\s*(\S+)\s*(?:\|\|\s*WHY:\s*(.*?))?\s*$/i;

/**
 * Parse one FINDING line (with or without its `FINDING:` label).
 * @returns {{ text: string, reach: 'REACHABLE'|'UNREACHABLE'|'untagged', why: string|null }}
 */
export function parseReachTag(line) {
  const body = String(line ?? '').replace(/^\s*(?:>\s*)?FINDING:\s*/i, '').trim();
  const m = TAG_RE.exec(body);
  if (!m) return { text: body, reach: 'untagged', why: null };
  const word = m[1].toUpperCase();
  const reach = word === 'REACHABLE' || word === 'UNREACHABLE' ? word : 'untagged';
  const why = (m[2] ?? '').trim() || null;
  return { text: body.slice(0, m.index).trim(), reach, why };
}

/** Count tags over parsed findings. */
export function countReach(findings) {
  const c = { findings: 0, reachable: 0, unreachable: 0, untagged: 0 };
  for (const f of findings ?? []) {
    c.findings += 1;
    if (f?.reach === 'REACHABLE') c.reachable += 1;
    else if (f?.reach === 'UNREACHABLE') c.unreachable += 1;
    else c.untagged += 1;
  }
  return c;
}

/** The durable log: one JSON line per composed verdict. `ORCHARD_REACH_LOG` overrides (tests). */
export function reachLogPath() {
  if (process.env.ORCHARD_REACH_LOG) return path.resolve(process.env.ORCHARD_REACH_LOG);
  const state = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(state, 'claude-station', 'reach-tags.jsonl');
}

const ONE_LINE = (v) => typeof v === 'string' && !/[\r\n\u2028\u2029]/.test(v);

/**
 * Shape problems of one stored verdict record. `findings[].reach` is optional (a verdict
 * composed before FEAT-208, or a HOLDS with no findings, carries none).
 */
export function reachRecordProblems(r) {
  const p = [];
  if (!r || typeof r !== 'object' || Array.isArray(r)) return ['record is not an object'];
  if (r.schema !== REACH_SCHEMA) p.push(`schema must be ${REACH_SCHEMA}`);
  if (!ONE_LINE(r.run_id) || !r.run_id) p.push('run_id must be a single-line string');
  if (!['HOLDS', 'BROKEN'].includes(r.verdict)) p.push('verdict must be HOLDS|BROKEN');
  if (r.ticket !== null && !(ONE_LINE(r.ticket) && /^[A-Z]+-\d+$/.test(r.ticket))) p.push('ticket must be a ticket id or null');
  if (!Array.isArray(r.findings)) p.push('findings must be an array');
  else for (const f of r.findings) {
    if (!f || typeof f !== 'object') { p.push('each finding must be an object'); continue; }
    if (!ONE_LINE(f.text)) p.push('finding text must be a single line');
    if (f.reach !== undefined && !REACH_VALUES.includes(f.reach)) p.push(`finding reach must be one of ${REACH_VALUES.join('|')}`);
    if (f.why !== undefined && f.why !== null && !ONE_LINE(f.why)) p.push('finding why must be a single line');
  }
  return p;
}

/**
 * Build the record for one composed verdict. `verdict` is copied from the harness's own
 * validation, never derived from the tags.
 */
export function buildReachRecord({ runId, ticket = null, repo = null, provider = null, model = null, candidate = null, verdict, findingLines, now = new Date() }) {
  const findings = (findingLines ?? []).map((l) => parseReachTag(l));
  return {
    schema: REACH_SCHEMA,
    run_id: String(runId ?? ''),
    ticket: ticket ?? null,
    repo: repo ?? null,
    provider: provider ?? null,
    model: model ?? null,
    candidate: candidate ?? null,
    verdict,
    recorded_at: now.toISOString(),
    counts: countReach(findings),
    findings,
  };
}

/** Append one record (one write call per line, O_APPEND). Throws on a bad shape. */
export function appendReachRecord(record, file = reachLogPath()) {
  const probs = reachRecordProblems(record);
  if (probs.length) throw new Error(`reach record invalid: ${probs.join('; ')}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return file;
}

/**
 * Read the log. The harness appends while this reads, so a torn or unparseable line is
 * skipped and counted, never fatal.
 * @returns {{ records: object[], skipped: number, file: string, missing: boolean }}
 */
export function readReachLog(file = reachLogPath()) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { records: [], skipped: 0, file, missing: true };
    throw e;
  }
  const records = []; let skipped = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { skipped += 1; continue; }
    if (reachRecordProblems(r).length) { skipped += 1; continue; }
    records.push(r);
  }
  return { records, skipped, file, missing: false };
}
