#!/usr/bin/env node
/**
 * check-scope.mjs — FEAT-039: makes consolidation-checklist question #5 real
 * ("is this rule project-specific masquerading as universal, or vice versa?").
 *
 * Two docs exist by design (FEAT-039):
 *   - the SHARED Working Agreement (docs/prompts/WORKING_AGREEMENT.v2.md) —
 *     injected into EVERY project's sessions. Only universal rules belong here;
 *     a project-specific rule that lands here pollutes every other project.
 *   - a per-project LOCAL conventions doc (<project>/docs/CONVENTIONS.md) —
 *     injected only into that project's sessions (see
 *     `localConventionsSection()` in src/server/templates.ts). A universal
 *     insight that lands only here never propagates to other projects that
 *     need it.
 *
 * Routing is currently discipline, not enforcement (§L asks the agent to
 * classify correctly but nothing checks it after the fact). This script is
 * the check: a HEURISTIC scan that flags likely-misfiled lines for a human to
 * triage. It is deliberately honest about being a heuristic — it reports
 * candidates, it never edits or moves text. A false positive here costs a
 * skim; a false "auto-fixed" would cost trust in the whole board.
 *
 * Usage:
 *   node scripts/check-scope.mjs
 *     Scans the real shared WA (docs/prompts/WORKING_AGREEMENT.v2.md) plus
 *     any docs/CONVENTIONS.md found under ~/projects/*​/ and
 *     ~/random_projects/*​/ (same roots registry.ts's scanForProjects() uses).
 *
 *   node scripts/check-scope.mjs --wa <path> --local <path>[,<path>...]
 *     Explicit files instead of the defaults (used by
 *     scripts/verify-check-scope.mjs so the test doesn't depend on what's
 *     registered on this machine).
 *
 * Exit code: 0 when nothing is flagged, 1 when there are candidates to
 * triage (so it can be wired into CI as an advisory gate later).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
export const DEFAULT_WA_PATH = path.join(ROOT, 'docs', 'prompts', 'WORKING_AGREEMENT.v2.md');

/* ------------------------------------------------------------- heuristics */

/**
 * Lines in the SHARED WA that smell project-specific. Each pattern names a
 * concrete, non-universal anchor: a specific project's name, a specific
 * stack/tool not every project uses, a hardcoded port, or a hardcoded
 * repo-relative path.
 */
export const PROJECT_SPECIFIC_PATTERNS = [
  { id: 'named-project', re: new RegExp(`\\b(external-project-[a-z0-9]+${process.env.STATION_PRIVATE_NAMES ? '|' + process.env.STATION_PRIVATE_NAMES.split(',').map((s) => s.trim()).filter(Boolean).join('|') : ''})\\b`, 'i'),
    why: 'names a specific project — belongs in that project\'s docs/CONVENTIONS.md, not the shared WA' },
  { id: 'named-stack', re: /\b(django|rails|laravel|postgres(?:ql)?|mysql|redis|kubernetes|k8s|mongodb)\b/i,
    why: 'names a specific stack/tool other projects may not use' },
  { id: 'hardcoded-port', re: /(?<!\d):\d{4,5}\b/,
    why: 'hardcodes a port number — almost always one project\'s dev/service port, not universal' },
  { id: 'hardcoded-path', re: /\b[\w.-]+\/(src|app|lib|scripts)\/[\w./-]+/,
    why: 'hardcodes a repo-relative path — likely describes one project\'s layout' },
];

/**
 * Lines in a LOCAL conventions doc that smell universal: broad "every
 * project/session" framing, or generic engineering hygiene with nothing
 * anchoring it to the project the doc belongs to.
 */
export const UNIVERSAL_SOUNDING_PATTERNS = [
  { id: 'every-project', re: /\bevery (project|session|repo|codebase)\b/i,
    why: 'says "every project/session" — sounds universal, belongs in the shared WA instead' },
  { id: 'all-projects', re: /\ball projects\b/i,
    why: 'says "all projects" — sounds universal, belongs in the shared WA instead' },
  { id: 'generic-git-hygiene', re: /\bnever (commit|force[- ]push|skip (hooks|tests|verification))\b/i,
    why: 'a generic git/process-hygiene rule with no project-specific anchor' },
  { id: 'any-codebase', re: /\bany (codebase|repo|project)\b/i,
    why: 'says "any codebase/repo/project" — sounds universal, belongs in the shared WA instead' },
];

/**
 * Lines to skip regardless of pattern hits: headings, blank lines, fenced
 * code, and HTML comments — these are structure/examples, not rule prose.
 */
function scanLines(text, patterns) {
  const lines = text.split(/\r?\n/);
  const findings = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('<!--')) continue;
    for (const p of patterns) {
      if (p.re.test(line)) {
        findings.push({ lineNo: i + 1, line: trimmed, patternId: p.id, why: p.why });
      }
    }
  }
  return findings;
}

export function scanSharedWA(text) {
  return scanLines(text, PROJECT_SPECIFIC_PATTERNS);
}

export function scanLocalDoc(text) {
  return scanLines(text, UNIVERSAL_SOUNDING_PATTERNS);
}

/* ---------------------------------------------------------------- report */

/**
 * @param {{ waPath?: string, localPaths?: string[] }} opts
 * @returns {{
 *   waPath: string, waFindings: Array,
 *   localDocs: Array<{ file: string, findings: Array }>,
 *   clean: boolean,
 * }}
 */
export function checkScope(opts = {}) {
  const waPath = opts.waPath ?? DEFAULT_WA_PATH;
  const localPaths = opts.localPaths ?? discoverLocalDocs();

  let waFindings = [];
  try {
    waFindings = scanSharedWA(fs.readFileSync(waPath, 'utf8'));
  } catch {
    // Missing shared WA is a separate, louder problem (seedTemplates() would
    // fail) — not this script's job to report; treat as no findings here.
  }

  const localDocs = [];
  for (const file of localPaths) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const findings = scanLocalDoc(text);
    if (findings.length) localDocs.push({ file, findings });
  }

  const clean = waFindings.length === 0 && localDocs.length === 0;
  return { waPath, waFindings, localDocs, clean };
}

/** Same roots registry.ts's scanForProjects() looks at — kept independent
 * (no import of registry.ts / data-dir state) so this script has no
 * dependency on a running station or its data dir. */
export function discoverLocalDocs(roots) {
  const home = os.homedir();
  const searchRoots = roots ?? [path.join(home, 'projects'), path.join(home, 'random_projects')];
  const found = [];
  for (const root of searchRoots) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const p = path.join(root, e.name, 'docs', 'CONVENTIONS.md');
      if (fs.existsSync(p)) found.push(p);
    }
  }
  return found;
}

/* --------------------------------------------------------------------- CLI */

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--wa') out.waPath = argv[++i];
    else if (argv[i] === '--local') out.localPaths = (argv[++i] ?? '').split(',').filter(Boolean);
  }
  return out;
}

function printReport(report) {
  console.log(`Shared WA: ${report.waPath}`);
  if (report.waFindings.length === 0) {
    console.log('  clean — no project-specific-sounding lines found');
  } else {
    console.log(`  ${report.waFindings.length} candidate(s) — likely misfiled (project-specific in a shared doc):`);
    for (const f of report.waFindings) {
      console.log(`    L${f.lineNo} [${f.patternId}] ${f.why}`);
      console.log(`      ${JSON.stringify(f.line)}`);
    }
  }
  console.log('');
  if (report.localDocs.length === 0) {
    console.log('Local conventions docs: none flagged (either none found, or all clean)');
  } else {
    for (const doc of report.localDocs) {
      console.log(`Local doc: ${doc.file}`);
      console.log(`  ${doc.findings.length} candidate(s) — likely misfiled (universal-sounding in a local doc):`);
      for (const f of doc.findings) {
        console.log(`    L${f.lineNo} [${f.patternId}] ${f.why}`);
        console.log(`      ${JSON.stringify(f.line)}`);
      }
    }
  }
  console.log('');
  console.log(report.clean
    ? 'check:scope — clean.'
    : 'check:scope — candidates found. Heuristic only: triage by hand, this script does not move anything.');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const report = checkScope(opts);
  printReport(report);
  process.exitCode = report.clean ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
