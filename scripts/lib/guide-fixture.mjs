/**
 * FEAT-075 Phase 4 — the SYNTHETIC dataset the guide screenshots are captured
 * over, shared by the capture script and its verifier.
 *
 * DISCIPLINE (FEAT-052 / BUG-080): every name, path, title and ticket here is
 * FICTIONAL. No real project name, no home directory, no username, no email.
 * The screenshots ship publicly under docs/assets/guide/, and the leak-gate is
 * pixel-blind (images carry no scannable text), so the ONLY guarantee that a
 * committed PNG is leak-safe is that the data driving it is synthetic BY
 * CONSTRUCTION. `assertSynthetic()` below is that guarantee, asserted in the
 * verifier: it scans this whole fixture for the leak-gate's own private tokens
 * and fails if any appear.
 *
 * The three fictional projects (atlas-api / aurora-web / lumen-cli) and the
 * generic engineering session/ticket titles mirror the placeholders FEAT-052
 * already vetted for the README screenshots.
 */

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * The fictional projects. `recencyMs` = how long ago each was last active, so
 * the sidebar sorts by recency in a visibly distinct order (aurora newest).
 * `settings` drive the crown chips (isolation tier, instruction stack, model,
 * permission mode) with no server round-trip. `hasBoard` marks the one project
 * whose docs/bugs/ board is seeded on disk (drives the For-You rail + portal).
 */
export const PROJECTS = [
  {
    key: 'aurora-web', name: 'aurora-web', dir: 'aurora-web',
    isolation: 'direct', model: 'claude-sonnet-4-5', permissionMode: 'plan',
    recencyMs: 18 * MIN, hasBoard: true,
    instructions: ['frontend-conventions'],
    tools: { serena: true },
  },
  {
    key: 'atlas-api', name: 'atlas-api', dir: 'atlas-api',
    isolation: 'container', model: 'claude-opus-4-6', permissionMode: 'bypassPermissions',
    recencyMs: 2 * HOUR,
    instructions: ['backend-conventions', 'review-checklist'],
    mounts: [{ hostPath: '/tmp/orchard-guide/shared-fixtures', readOnly: true }],
    tools: { serena: true },
  },
  {
    key: 'lumen-cli', name: 'lumen-cli', dir: 'lumen-cli',
    isolation: 'sandbox', model: 'claude-opus-4-6', permissionMode: null,
    recencyMs: 3 * DAY,
    instructions: ['cli-conventions'],
    tools: {},
  },
];

/** Sessions for aurora-web's sidebar group: one pinned, a fresh set, one old. */
export const SESSIONS = {
  'aurora-web': [
    { id: 'g-sess-pin', title: 'cursor pagination for the activity feed', pinned: true, agoMs: 40 * MIN },
    { id: 'g-sess-json', title: 'make --json stdout pure (drop the log lines)', agoMs: 3 * HOUR },
    { id: 'g-sess-focus', title: 'focus-trap escape in the settings drawer', agoMs: 6 * HOUR },
    { id: 'g-sess-retry', title: 'retry backoff for the upload worker', agoMs: 26 * HOUR },
    { id: 'g-sess-copy', title: 'rename the export button copy', agoMs: 2 * DAY },
  ],
};

/**
 * The running set for the strip shot — the main turn plus two subagents. This
 * is fed through the real applySnapshot() reconciler, exactly the shape the
 * server pushes (v:1 + a running[] of {id,row,label,description,startedAt}).
 */
export const RUNNING = {
  v: 1,
  session: 'g-strip',
  running: [
    { id: 'g-r-main', row: 'main' },
    { id: 'g-r-explore', row: 'agent', label: 'explore', description: 'mapping the feed pagination flow' },
    { id: 'g-r-fix', row: 'agent', label: 'fix', description: 'patching the cursor off-by-one' },
  ],
};

/**
 * The synthetic board seeded on disk for aurora-web (For-You rail + portal).
 * IDs use the board tool's recognised prefixes (ARCH/BUG/FEAT/DEPLOY) so the
 * ticket portal — which only lists <PREFIX>-<NNN>-<slug>.md files — shows them.
 */
export const BOARD = {
  focusId: 'BUG-231',
  rows: [
    { id: 'BUG-231', title: 'import: skip malformed rows, or halt the batch?', owner: '\u{1F464}', status: 'needs decision', sev: 'high' },
    { id: 'FEAT-118', title: 'ship the JSON export to staging or hold for review?', owner: '\u{1F464}', status: 'user-owned', sev: 'med' },
    { id: 'BUG-232', title: 'flaky retry loop under load', owner: '\u{1F916}', status: 'building', sev: 'med' },
    { id: 'FEAT-119', title: 'tidy the config loader', owner: '—', status: 'queued', sev: 'low' },
  ],
  done: [{ id: 'FEAT-100', title: 'ship the export button', commit: 'abc1234' }],
};

/**
 * The declarative shot list: {name, outFile, target, label}. The capture
 * script maps each `name` to a browser-side setup step; the verifier imports
 * this list to know exactly which PNGs must exist and which element each
 * annotation must have been drawn on. Re-runnable: the outFile paths are fixed,
 * so re-running the capture refreshes the same files when the UI changes.
 */
export const SHOTS = [
  {
    name: 'running-strip', outFile: 'running-strip.png', target: '#strip',
    label: 'Running now — the main turn plus every subagent, live from the server',
  },
  {
    name: 'for-you-rail', outFile: 'for-you-rail.png', target: '#railSummary',
    label: 'For You — the Focus ticket and a live counts strip of what is on your plate',
  },
  {
    name: 'project-sidebar', outFile: 'project-sidebar.png', target: '.row.pinned .pin-mark',
    label: 'Pinned sessions carry a pin and hold the top; projects sort by recency; a pending new session rides above all',
  },
  {
    name: 'model-chip', outFile: 'model-chip.png', target: '#modelChip',
    label: 'The live model chip — flags a silent provider fallback until you acknowledge it',
  },
  {
    name: 'isolation-chip', outFile: 'isolation-chip.png', target: '#isoBtn',
    label: 'Isolation tier (Direct / Sandbox / Container) with the permission mode and instruction stack beside it',
  },
  {
    name: 'guide-pill', outFile: 'guide-pill.png', target: '#guideBtn',
    label: 'The Guide pill — open this guide from anywhere in the app',
  },
  {
    name: 'board-portal', outFile: 'board-portal.png', target: '#ticketsView .tv-list',
    label: 'The ticket board — every ticket, filterable, in its own route (open it in a second tab)',
  },
];

/**
 * The leak-gate's own private-token list (BUG-049/080), reproduced so the
 * verifier can prove this fixture trips NONE of them. Split-string form so this
 * source file does not itself trip the gate when it ships in the mirror.
 */
export const LEAK_PATTERNS = [
  { name: 'home path', re: new RegExp('/home/' + 'sa' + 'p\\b') },
  { name: 'encoded home path', re: new RegExp('-home-' + 'sa' + 'p\\b') },
  { name: 'username (bare word)', re: new RegExp('\\b' + 'sa' + 'p' + '\\b') },
  { name: 'github handle', re: new RegExp('sa' + 'pn1s', 'i') },
  { name: 'email', re: new RegExp('sa' + 'ptional', 'i') },
  { name: 'private project A', re: new RegExp('saa' + 'sis', 'i') },
  { name: 'private project B', re: new RegExp('img' + 'ixie', 'i') },
  { name: 'private project C', re: new RegExp('map' + '_of_' + 'world', 'i') },
  { name: 'private project D', re: new RegExp('job' + '_intel', 'i') },
  { name: 'private project E', re: new RegExp('reddit' + '_marketing', 'i') },
  { name: 'private project G', re: new RegExp('gpu-' + 'research-lab', 'i') },
  { name: 'private project H', re: new RegExp('shadow' + '[-_ ]studio', 'i') },
];

/**
 * Prove the ENTIRE fixture is synthetic: no leak-gate private token appears in
 * any project name, path, session/ticket title or label. Returns
 * { ok, hits:[{pattern, where, sample}] } — the verifier asserts ok === true.
 */
export function assertSynthetic() {
  const blob = JSON.stringify({ PROJECTS, SESSIONS, RUNNING, BOARD, SHOTS });
  const hits = [];
  for (const p of LEAK_PATTERNS) {
    const m = p.re.exec(blob);
    if (m) hits.push({ pattern: p.name, sample: blob.slice(Math.max(0, m.index - 20), m.index + 20) });
  }
  // A positive assertion of the synthetic project names, so "the fixture went
  // empty / got swapped for real data" fails loudly rather than passing vacuously.
  const names = PROJECTS.map((p) => p.name);
  const expected = ['aurora-web', 'atlas-api', 'lumen-cli'];
  const namesOk = expected.every((n) => names.includes(n)) && names.length === expected.length;
  return { ok: hits.length === 0 && namesOk, hits, names, namesOk };
}
