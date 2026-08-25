/**
 * neighbor-project.mjs — machine-agnostic discovery of a REAL sibling project
 * for live verification (FEAT-049: no hardcoded home paths / project names).
 *
 * Some verify scripts need "a real project on this machine, other than this
 * repo, that has recorded ~/.claude sessions". Previously that was a hardcoded
 * absolute path; now it is discovered (or pinned via STATION_VERIFY_PROJECT).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The CLI's store-dir encoding: every non-alphanumeric char becomes '-'. */
export function encodeStoreDir(p) {
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Encoded store dir name for $HOME itself (sessions launched from ~). */
export function homeEncoded() {
  return encodeStoreDir(os.homedir());
}

/**
 * Find a real project dir (not `excludePath`) that has at least one recorded
 * session. Honors STATION_VERIFY_PROJECT; otherwise scans ~/projects and
 * ~/random_projects alphabetically. Throws (loud precondition) if none.
 */
export function findNeighborProject({ excludePath } = {}) {
  const env = process.env.STATION_VERIFY_PROJECT;
  if (env && env.trim()) return path.resolve(env.trim());
  const store = path.join(os.homedir(), '.claude', 'projects');
  const roots = ['projects', 'random_projects'].map((d) => path.join(os.homedir(), d)).filter((d) => fs.existsSync(d));
  for (const root of roots) {
    for (const name of fs.readdirSync(root).sort()) {
      const host = path.join(root, name);
      if (excludePath && path.resolve(host) === path.resolve(excludePath)) continue;
      let st;
      try { st = fs.statSync(host); } catch { continue; }
      if (!st.isDirectory()) continue;
      try {
        if (fs.readdirSync(path.join(store, encodeStoreDir(host))).some((f) => f.endsWith('.jsonl'))) return host;
      } catch { /* no store dir for this project */ }
    }
  }
  throw new Error('precondition failed: no neighbor project with recorded sessions found — set STATION_VERIFY_PROJECT=<hostPath>');
}
