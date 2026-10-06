/**
 * BUG-223 round 6: the dispatch broker re-reads its project BY ID from the registry for every
 * lane (ARCH-010: no cached copy of the path or the laneDocker declaration), and refuses a lane
 * for a project that is not registered. A suite that starts a broker on a fixture project must
 * therefore register that fixture in the registry of the data dir that is active when the lane
 * is dispatched. This merges the rows into `<dataDir>/registry.json` (replacing a row by id).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export function registerFixtureProjects(dataDir, ...projects) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'registry.json');
  let reg = { version: 1, projects: [] };
  try { reg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!Array.isArray(reg.projects)) reg.projects = [];
  for (const p of projects) {
    reg.projects = reg.projects.filter((row) => row?.id !== p.id);
    reg.projects.push(p);
  }
  fs.writeFileSync(file, `${JSON.stringify(reg, null, 2)}\n`);
  return file;
}
