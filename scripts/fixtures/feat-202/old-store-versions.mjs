/** Round-2 (watcher-based) store-versions module — reconstructed verbatim as a
 *  plain-JS fixture for the FEAT-202 round-3 must-FAIL repro. The committed
 *  round-2 file was untracked and was replaced in place by the round-3 rewrite,
 *  so this frozen copy is how we reproduce the deaf-watcher regression
 *  (anthropic run 5b838160, BROKEN) side by side with the fix. */
import * as fs from 'node:fs';

let outcomesVer = 0;
let pendingVer = 0;
let boardEpoch = 0;
const boardDirVer = new Map();

export function bumpOutcomes() { outcomesVer++; }
export function bumpPending() { pendingVer++; boardEpoch++; }
export function bumpDecisions() { boardEpoch++; }
export function bumpBoardDir(projectId) {
  boardDirVer.set(projectId, (boardDirVer.get(projectId) ?? 0) + 1);
}

export function boardVersionFor(projectId) {
  return (boardDirVer.get(projectId) ?? 0) + boardEpoch;
}

export function snapshot(projectIds) {
  const board = {};
  for (const id of projectIds) board[id] = boardVersionFor(id);
  return { outcomes: outcomesVer, pending: pendingVer, board };
}

const debouncers = new Map();
function debounced(key, fn) {
  const prev = debouncers.get(key);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => { debouncers.delete(key); try { fn(); } catch { /* */ } }, 200);
  if (typeof t.unref === 'function') t.unref();
  debouncers.set(key, t);
}

const dataWatchers = new Map();
export function armDataDirWatch(dir) {
  if (!dir || dataWatchers.has(dir)) return;
  let w;
  try {
    w = fs.watch(dir, { persistent: false }, (_event, filename) => {
      const f = String(filename ?? '');
      if (f === 'agent-outcomes.json') debounced(`${dir}:outcomes`, bumpOutcomes);
      else if (f === 'lanes.json' || f === 'group-seals.json') debounced(`${dir}:pending`, bumpPending);
      else if (f === 'decisions.json') debounced(`${dir}:decisions`, bumpDecisions);
    });
  } catch { return; }
  w.on('error', () => { try { w.close(); } catch { /* */ } dataWatchers.delete(dir); });
  dataWatchers.set(dir, w);
}

const boardWatchers = new Map();
export function armBoardWatch(projectId, boardDir) {
  if (!projectId || !boardDir || boardWatchers.has(projectId)) return;
  if (!fs.existsSync(boardDir)) return;
  let w;
  try {
    w = fs.watch(boardDir, { persistent: false }, () => {
      debounced(`board:${projectId}`, () => bumpBoardDir(projectId));
    });
  } catch { return; }
  w.on('error', () => { try { w.close(); } catch { /* */ } boardWatchers.delete(projectId); });
  boardWatchers.set(projectId, w);
}

export function _closeAll() {
  for (const w of dataWatchers.values()) { try { w.close(); } catch { /* */ } }
  for (const w of boardWatchers.values()) { try { w.close(); } catch { /* */ } }
  dataWatchers.clear();
  boardWatchers.clear();
}
