#!/usr/bin/env node
/**
 * release.mjs — FEAT-164 soft releases: the ONE command that promotes finished,
 * verified tickets into a project's real repo as a versioned release commit.
 *
 *   node scripts/release.mjs plan   <project|path> [--json]
 *       What the next release would hold, what is excluded and why, and whether it is due.
 *   node scripts/release.mjs cut    <project|path> [--now] [--push|--no-push] [--dry-run] [--json]
 *       Cut it: one commit + one version tag for the whole batch, after the gate and the
 *       tests pass on the exact release tree. --now skips only the cadence (user only).
 *   node scripts/release.mjs cut    <project> --via-station [--json]
 *       From an agent session: ask the station to cut it under the project's grant
 *       (cadence enforced, never --now).
 *   node scripts/release.mjs push   <project|path>
 *       Retry the push of the latest release that is not on the remote yet.
 *   node scripts/release.mjs auto   <project|path> [--json]
 *       The station's tick: cut if the project is in release mode and a release is due.
 *   node scripts/release.mjs policy <project|path>
 *       Print what agents are told about git in this project.
 *
 * Exit: 0 released / nothing to do, 1 refused (reason printed), 2 usage or setup error.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cutRelease, planRelease, pushPending, resolveTarget, releaseAlarm, boardVerdictSource, ReleaseError } from './lib/release.mjs';
import { agentGitPolicyNote, policySummary, NEVER_RELEASES_PREFIX } from './lib/agent-git-policy.mjs';
import { CandidateError } from './lib/candidate-store.mjs';

const ORCHARD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const verb = argv[0];
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const pos = argv.slice(1).filter((a) => !a.startsWith('--'));
const json = flags.has('--json');
const out = (o, text) => { process.stdout.write(json ? JSON.stringify(o, null, 2) + '\n' : text + '\n'); };

function usage(msg) {
  if (msg) process.stderr.write(`release: ${msg}\n`);
  process.stderr.write('usage: release.mjs plan|cut|push|auto|policy <project|path> [--now] [--push|--no-push] [--dry-run] [--via-station] [--json]\n');
  process.exit(2);
}

function planText(p) {
  const lines = [`${p.top} — ${p.mode === 'none' ? 'no agent-commit grant' : `mode ${p.mode}`}; last release: ${p.last ? `${p.last.version} (${p.last.at})` : 'none'}`];
  lines.push(`Next: ${p.nextVersion}${p.previousVersion ? ` (after ${p.previousVersion})` : ''} — ${p.cadence.due ? 'DUE' : 'not due'}: ${p.cadence.why}`);
  lines.push(`Cadence: ≥${p.cadence.minTickets} tickets or ${p.cadence.maxWaitHours} h wait; at most one per ${p.cadence.minIntervalHours} h.`);
  if (p.eligible.length) {
    lines.push('Eligible (verified):');
    for (const e of p.eligible) lines.push(`  ✓ ${e.members.join(' + ')}  candidate ${e.hash.slice(0, 12)}`);
  }
  if (p.excluded.length) {
    lines.push('Excluded:');
    for (const x of p.excluded) lines.push(`  ✗ ${x.ticket}  ${x.reasons[0]}${x.reasons.length > 1 ? ` (+${x.reasons.length - 1} more)` : ''}`);
  }
  return lines.join('\n');
}

async function viaStation(projectId) {
  const port = Number(process.env.PORT ?? 4317);
  const res = await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(projectId)}/release`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function main() {
  if (!['plan', 'cut', 'push', 'auto', 'policy'].includes(verb)) usage(verb ? `unknown verb ${verb}` : 'a verb is required');
  if (pos.length !== 1) usage('name exactly one project id or repo path');
  const { repo, project, policy } = resolveTarget(pos[0]);
  if (verb === 'policy') {
    const note = agentGitPolicyNote(policy, { orchardDir: ORCHARD, projectId: project?.id ?? pos[0] });
    out({ project: project?.id ?? null, policy, note }, `${policySummary(policy)}${note ? `\n\n${note}` : ''}`);
    return 0;
  }
  if (!repo) usage(`${pos[0]} has no repository path`);
  if (verb === 'plan') {
    let p;
    try { p = await planRelease({ repo, policy }); }
    catch (e) {
      // The Settings warning must still learn "can never release" when the plan itself
      // cannot be built (no base commit, not a git repo) — verify b0587b41.
      const verdictSource = await boardVerdictSource(repo).catch(() => null);
      out({ error: e.code ?? 'plan-failed', reason: e.message, verdictSource }, `plan failed: ${e.message}`);
      return 1;
    }
    const { _rows, ...rest } = p;
    out(rest, planText(p));
    return 0;
  }
  if (verb === 'push') {
    const r = await pushPending({ repo, policy, trigger: 'user' });
    out(r, r.nothing ? 'Nothing to push: every release is on the remote.' : r.ok ? `Pushed ${r.ref} + tag to ${r.remote}.` : `Push failed: ${r.reason}`);
    return r.ok ? 0 : 1;
  }
  if (verb === 'cut' && flags.has('--via-station')) {
    if (!project) usage('--via-station needs a registered project');
    const { status, body } = await viaStation(project.id);
    out(body, body.released ? `Released ${body.version} (${body.tickets.join(', ')})${body.pushed?.ok ? ', pushed' : ''}.` : `Not released (${status}): ${body.reason || body.error || 'unknown'}`);
    return status === 200 ? 0 : 1;
  }
  // 2026-10-13 — the tick: a release-mode project that can NEVER release says so before any
  // git work (which may itself fail on a repo with no base commit) — verify b0587b41.
  if (verb === 'auto' && policy.mode === 'release') {
    const vs = await boardVerdictSource(repo).catch(() => null);
    if (vs && !vs.ok) { out({ released: false, reason: vs.reason, alarm: `${NEVER_RELEASES_PREFIX}${vs.reason}` }, `No release: ${vs.reason}`); return 0; }
  }
  // --as-agent: the station's route for an agent's request (stricter: grant + cadence, no --now).
  const trigger = verb === 'auto' ? 'auto' : flags.has('--as-agent') ? 'agent' : 'user';
  if (trigger === 'user' && flags.has('--push') && flags.has('--no-push')) usage('--push and --no-push together');
  const push = flags.has('--push') ? true : flags.has('--no-push') ? false : null;
  let r;
  try {
    r = await cutRelease({ repo, policy, trigger, now: flags.has('--now'), push, dryRun: flags.has('--dry-run') });
  } catch (e) {
    // The station's tick needs the alarm even when the cut was refused (plan review #4).
    if (trigger === 'auto' && (e instanceof ReleaseError || e instanceof CandidateError)) {
      const alarm = await releaseAlarm({ repo, policy }).catch(() => null);
      out({ released: false, error: e.code, reason: e.message, detail: e.detail ?? [], alarm }, `release refused (${e.code}): ${e.message}${alarm ? `\nALARM: ${alarm}` : ''}`);
      return 1;
    }
    throw e;
  }
  if (trigger === 'auto') r.alarm = await releaseAlarm({ repo, policy }).catch(() => null);
  if (r.released) {
    out(r, [
      `Released ${r.version}: ${r.tickets.length} ticket(s) in one commit ${r.commit.slice(0, 12)} — ${r.tickets.join(', ')}.`,
      `Checks passed on the exact tree: ${r.checks.map((c) => c.cmd).join('; ')}.`,
      r.pushed.ok ? `Pushed to ${r.pushed.remote} (${r.pushed.ref}) with the tag.` : `Not pushed: ${r.pushed.reason}${r.pushed.skipped ? '' : ' — retry: node scripts/release.mjs push ' + pos[0]}`,
    ].join('\n'));
  } else if (r.dryRun) {
    out(r, `Dry run: ${r.version} would hold ${r.plan.tickets.join(', ')} (tree ${r.tree.slice(0, 12)}); checks: ${r.checks.join('; ')}.`);
  } else {
    out(r, `No release: ${r.reason}`);
  }
  return 0;
}

main().then((code) => process.exit(code ?? 0)).catch((e) => {
  if (e instanceof ReleaseError || e instanceof CandidateError) {
    if (json) process.stdout.write(JSON.stringify({ released: false, error: e.code, reason: e.message, detail: e.detail ?? [] }, null, 2) + '\n');
    else process.stderr.write(`release refused (${e.code}): ${e.message}\n${(e.detail ?? []).join('\n')}\n`);
    process.exit(1);
  }
  process.stderr.write(`release: ${e?.stack || e}\n`);
  process.exit(2);
});
