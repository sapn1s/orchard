#!/usr/bin/env node
/**
 * verify-feat-190-registry.mjs — FEAT-190, the POLICY WRITER through the REAL registry (seal +
 * normalize), in-process. Covers D2 end-to-end and the migration-safety FIX for IV run 93ad10c2
 * BROKEN: a re-grant that specifies no release intent (the setGitWritePermanent / CLI compat path)
 * must NOT flip a release record into scoped + direct push. Uses a scratch CLAUDE_STATION_DATA and a
 * real git repo (real git binary, bypassing the agent shim, for the fixture only).
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let pass = 0, fail = 0;
const ok = (c, m, obs) => { if (c) pass++; else { fail++; console.error(`  FAIL: ${m}${obs === undefined ? '' : ` — ${JSON.stringify(obs)}`}`); } };

function realGit() { for (const d of (process.env.PATH ?? '').split(path.delimiter)) { if (!d || d.includes('shim')) continue; const g = path.join(d, 'git'); try { if (fs.statSync(g).isFile()) return g; } catch { /* next */ } } return '/usr/bin/git'; }

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'f190-reg-data-'));
const REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'f190-reg-repo-'));
process.env.CLAUDE_STATION_DATA = DATA; // MUST precede the registry import (dataDir reads it)
const GIT = realGit();
const genv = { ...process.env, GIT_AUTHOR_NAME: 'v', GIT_AUTHOR_EMAIL: 'v@example.invalid', GIT_COMMITTER_NAME: 'v', GIT_COMMITTER_EMAIL: 'v@example.invalid' };
try {
  execFileSync(GIT, ['init', '-b', 'main', REPO], { env: genv });
  fs.writeFileSync(path.join(REPO, 'f'), 'x');
  execFileSync(GIT, ['-C', REPO, 'add', '-A'], { env: genv });
  execFileSync(GIT, ['-C', REPO, 'commit', '-m', 'i'], { env: genv });

  const reg = await import('../src/server/registry.ts');
  const p = reg.createProject({ hostPath: REPO, isolation: 'direct' });
  const read = () => reg.gitWritePolicyOf(p.id);

  // D2 — a plain grant → scoped + commit + push ON by default (through the real seal/normalize).
  reg.setGitWritePolicy(p.id, { commit: true, push: true, scope: null }, { via: 'test' });
  let pol = read();
  ok(pol.mode === 'scoped' && pol.commit && pol.push, 'plain grant → scoped + commit + push', pol);

  // push:false honoured.
  reg.setGitWritePolicy(p.id, { commit: true, push: false, scope: null }, { via: 'test' });
  pol = read();
  ok(pol.mode === 'scoped' && pol.commit && !pol.push, 'push:false → scoped, no push', pol);

  // Explicit release opt-in → release.
  reg.setGitWritePolicy(p.id, { commit: true, push: true, scope: null, release: { opt_in: true } }, { via: 'test' });
  pol = read();
  ok(pol.mode === 'release', 'release.opt_in:true → release', pol);

  // THE FIX (IV 93ad10c2) — a re-grant via the compat PERMANENT route sends NO release intent; it
  // must PRESERVE release, never flip to scoped + direct push.
  reg.setGitWritePermanent(p.id, true, { via: 'test' });
  pol = read();
  ok(pol.mode === 'release', 'a permanent re-grant PRESERVES release mode (no silent flip to scoped)', pol);

  // And a plain setGitWritePolicy with no release on the release record ALSO preserves release
  // (same no-intent path).
  reg.setGitWritePolicy(p.id, { commit: true, push: true, scope: null }, { via: 'test' });
  pol = read();
  ok(pol.mode === 'release', 'a no-release re-save PRESERVES release mode', pol);

  // Explicitly opting OUT of release (new UI) → scoped.
  reg.setGitWritePolicy(p.id, { commit: true, push: true, scope: null, release: { opt_in: false } }, { via: 'test' });
  pol = read();
  ok(pol.mode === 'scoped' && pol.push, 'explicit release.opt_in:false → scoped + push (user chose it)', pol);

  // D7 — the stored allowance never exceeds what was submitted (commit-only, push omitted-false).
  reg.setGitWritePolicy(p.id, { commit: true, push: false, scope: 'guidance' }, { via: 'test' });
  pol = read();
  ok(pol.commit && !pol.push, 'commit-only save stores commit without push (no over-grant)', pol);
} finally {
  for (const d of [DATA, REPO]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
}
console.log(`\nFEAT-190 registry integration: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
