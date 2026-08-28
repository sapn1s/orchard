#!/usr/bin/env node
/**
 * git-grant.mjs — FEAT-108 round 2. The USER's command-line surface to grant,
 * revoke, or inspect a runtime git-write grant for a project, WITHOUT relaunching
 * any session. It is a thin client over the running Orchard server's grant route
 * (the grant itself lives in the server's memory — see git-grant-store.mjs), so a
 * grant issued here takes effect on a live session's next tool call.
 *
 *   node scripts/git-grant.mjs <project>              # grant ONE occasion (single git write)
 *   node scripts/git-grant.mjs <project> --minutes 15 # grant a 15-minute window
 *   node scripts/git-grant.mjs <project> --revoke     # revoke
 *   node scripts/git-grant.mjs <project> --status     # show current grant + recent writes
 *   node scripts/git-grant.mjs --list                 # projects + their grant state
 *
 * <project> matches a project by id or (case-insensitively) by name. The server
 * is reached at 127.0.0.1:$PORT (default 4317).
 *
 * WHY A COMMAND AND NOT ONLY A BUTTON: the git dashboard panel is being reworked
 * on another lane, so this self-contained command is the primary user surface;
 * the HTTP route it calls is exactly what a dashboard "Allow git writes" button
 * would call. Being a user-run command, it is a legitimate grant SOURCE — an
 * agent cannot make itself the user (and even if a same-user process forged the
 * call over loopback, a granted commit still faces the mandatory leak gate).
 */
const PORT = Number(process.env.PORT ?? 4317);
const BASE = `http://127.0.0.1:${PORT}`;

async function j(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${data.error ?? text}`);
  return data;
}

async function resolveProject(needle) {
  const { projects } = await j('GET', '/api/projects');
  const byId = projects.find((p) => p.id === needle);
  if (byId) return byId;
  const byName = projects.filter((p) => p.name.toLowerCase() === String(needle).toLowerCase());
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) throw new Error(`"${needle}" matches ${byName.length} projects by name; use the id (see --list)`);
  throw new Error(`no project matches "${needle}" (id or name); run --list`);
}

function fmtGrant(g) {
  if (!g) return 'none';
  const mins = Math.round((g.expiresInMs ?? 0) / 60000);
  return `scope=${g.scope} · uses=${g.remainingUses ?? '∞'} · expires in ~${mins}m (${g.expiresAt}) · via ${g.grantedVia}`;
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    console.log('usage: node scripts/git-grant.mjs <project> [--once|--minutes N|--revoke|--status]   |   --list');
    process.exit(args.length ? 0 : 1);
  }
  if (args.includes('--list')) {
    const { projects } = await j('GET', '/api/projects');
    for (const p of projects) {
      let g = null;
      try { g = (await j('GET', `/api/projects/${p.id}/git-write-grant`)).grant; } catch { /* ignore */ }
      console.log(`${p.id.padEnd(24)} ${p.name.padEnd(24)} git-write: ${fmtGrant(g)}`);
    }
    return;
  }
  const needle = args.find((a) => !a.startsWith('--'));
  if (!needle) throw new Error('name a project (id or name), or use --list');
  const p = await resolveProject(needle);

  if (args.includes('--status')) {
    const s = await j('GET', `/api/projects/${p.id}/git-write-grant`);
    console.log(`project ${p.id} (${p.name})\n  grant: ${fmtGrant(s.grant)}`);
    console.log(`  recent agent git writes: ${s.recentWrites.length}`);
    for (const w of s.recentWrites.slice(0, 10)) {
      console.log(`    ${w.at}  ${w.offender}  gate=${w.gatePassed === null ? 'n/a' : w.gatePassed ? 'pass' : 'FAIL'}  ${w.command ?? ''}`);
    }
    return;
  }
  if (args.includes('--revoke')) {
    const r = await j('DELETE', `/api/projects/${p.id}/git-write-grant`);
    console.log(`revoked git-write grant for ${p.id} (${p.name}) — ${r.revoked ? 'was active' : 'none was active'}`);
    return;
  }
  const mi = args.indexOf('--minutes');
  const minutes = mi >= 0 ? Number(args[mi + 1]) : undefined;
  const scope = minutes && minutes > 0 ? 'duration' : 'once';
  const r = await j('POST', `/api/projects/${p.id}/git-write-grant`, { scope, minutes });
  console.log(`granted git-write for ${p.id} (${p.name}): ${fmtGrant(r.grant)}`);
  console.log('  (a granted commit/push still runs the mandatory leak gate and is refused on a leak)');
}

main().catch((e) => { console.error(`git-grant: ${e.message}`); process.exit(1); });
