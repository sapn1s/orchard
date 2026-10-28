/**
 * FEAT-202 (round 3) — ONE aggregate "did anything change" signal per tab,
 * derived from a cheap STAT FINGERPRINT computed on demand.
 *
 * WHY NOT WATCHERS (the round-2 regression). Round 2 maintained version counters
 * from a DIRECTORY-level `fs.watch` per store dir plus in-process bumps. On
 * Linux, REMOVING a watched directory emits no error event — the FSWatcher goes
 * silently deaf, stays registered, and a re-arm is a no-op (the Map still holds
 * the dead watcher). After a remove-then-recreate of the board dir, external
 * ticket writes never moved the counter and the board went stale FOREVER
 * (anthropic run 5b838160, BROKEN). Watcher liveness is a timing, not a shape,
 * and could not be made correct across every filesystem event.
 *
 * WATCHERS ARE HINTS, NOT TRUTH. Each store's version is now derived on demand
 * from a stat fingerprint: the dir's own (mtimeNs, ino) plus every entry's
 * (name, mtimeNs, size, ino) for the board dir, and the (mtimeNs, size, ino) of
 * each backing file for the dataDir stores, all hashed. A recreated dir (new
 * ino), an atomic temp+rename (new ino), an external editor (new mtime/size)
 * all change the fingerprint BY CONSTRUCTION — there is no watcher state left to
 * go stale, deaf, or unarmed. A removed dir reads as 'absent' and a recreate
 * reads as a fresh ino; both differ from the prior fingerprint, so the counter
 * moves on the next poll with no re-arm needed.
 *
 * COST. The per-directory scan (readdir + one stat per entry) is cached for
 * ~1s and shared across every tab, so N tabs polling /api/versions within the
 * same second cost ONE scan of each dir, not N. The dataDir stores are statted
 * individually (four known files), not by scanning the whole data dir. Measured
 * on the real board dir (~470 files) the scan is sub-millisecond-to-low-ms; see
 * scripts/verify-feat-202-round3.mjs.
 *
 * IN-PROCESS BUMPS (kept as zero-latency accelerators). The server owns the
 * writes to outcomes/lanes/decisions (temp+rename via writeAtomic), so it bumps
 * a monotonic counter at those chokepoints. The counter is FOLDED INTO the
 * fingerprint and read live (not cached), so an in-process write is reflected
 * instantly, before the ~1s scan cache would even expire. But CORRECTNESS DOES
 * NOT DEPEND ON THEM: a write that somehow bypassed the chokepoint (a verify
 * script, a second tool, an external editor) still moves the fingerprint via its
 * stat change. The bumps only lower latency for the common in-process path.
 *
 * RESTART SAFETY. The bump counters are in-memory and reset to 0 on restart, and
 * a recreated-then-identical file could in principle hash the same across a
 * restart. Both are covered by the persisted `boot` generation the endpoint
 * prefixes (index.ts `accountFactBoot`, the BUG-255 pattern): a client that held
 * a snapshot across a restart sees a changed `boot` and refetches everything.
 *
 * THE BOARD IS A COMPOSITE. Its needsYou list merges the project's docs/bugs
 * tickets with lane cards (lanes.json) and raised decisions (decisions.json).
 * So a project's board fingerprint folds in the board dir fingerprint AND the
 * lanes + decisions file fingerprints. An over-eager board move costs only a
 * 304 on the client's board conditionalGet (round 1), never stale bytes, so we
 * fold generously and stay correct rather than precisely and risk missing a
 * composite input.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

/* ─────────────────────────── in-process bump counters ──────────────────── */

let outcomesBump = 0;
let pendingBump = 0;
let decisionsBump = 0;
let boardBump = 0;

export function bumpOutcomes(): void { outcomesBump++; }
/** Lanes feed BOTH the pending surface and the board's needsYou lane cards. */
export function bumpPending(): void { pendingBump++; boardBump++; }
/** Decisions feed the board's needsYou decision cards (no separate client poll). */
export function bumpDecisions(): void { decisionsBump++; boardBump++; }
/**
 * A board-wide bump folded into EVERY project's board fingerprint, for board
 * needsYou inputs that have no OWN backing file the board stat scan covers:
 * raised decisions and held lanes (bumped via bumpDecisions/bumpPending above —
 * their files ARE statted too, so this is a zero-latency accelerator for them).
 *
 * NOT covered by any bump: the remaining SERVER-DERIVED board inputs that have no
 * stable file and change on in-process timers — the base-update notice (release
 * catalog + pin), the grant-rebuild rail items (in-memory), and the pilot-only
 * ref-ledger alarm (git refs). Those are bounded by the CLIENT's slow
 * BOARD_POLL_MS (20s) board safety refresh, which matches FEAT-202 round 1's own
 * 20s board cadence (so it is no regression) — not by this counter. Wiring
 * bumpBoard() to each of their mutation points (for ≤5s) is a possible follow-up;
 * grant-rebuild is dependency-injected and self-ticking, so it needs an injected
 * onChange, not a call-site bump. An over-eager bump costs only a 304.
 */
export function bumpBoard(): void { boardBump++; }

/* ───────────────────────────── stat fingerprints ───────────────────────── */

/** How long one directory scan is reused across every tab's poll. */
const SCAN_TTL_MS = 1000;

type DirScan = { at: number; dirStat: string; files: Map<string, string> };
const dirScanCache = new Map<string, DirScan>();

type FileStats = { at: number; stats: Map<string, string> };
const fileStatCache = new Map<string, FileStats>();

/**
 * (mtimeNs, ctimeNs, size, ino). ctimeNs is included because a same-size,
 * same-inode content rewrite with the mtime RESTORED (cp -p, rsync -t --inplace,
 * tar -x, touch -r, or a coarse-clock collision) leaves mtime/size/ino unchanged
 * but moves ctime — and ctime CANNOT be set from user space, so it is the one
 * field such a write cannot hide behind. Over-sensitive at worst (a chmod moves
 * it with no content change), which costs only a 304 on the client's
 * conditionalGet, never stale bytes.
 */
function fileFp(st: fs.BigIntStats): string {
  return `${st.mtimeNs}:${st.ctimeNs}:${st.size}:${st.ino}`;
}

/**
 * The whole board dir, RECURSIVELY: its own (mtimeNs, ino) + every entry's
 * (relative-path, fp) at any depth, cached ~1s. The recursion matters — the
 * board's needsYou merges `docs/bugs/.arch/findings.json` and `.arch/acks.json`
 * (a SUBDIRECTORY, rewritten IN PLACE by the arch tooling). A non-recursive scan
 * would miss those: a Linux directory's own mtime does NOT change when an
 * existing entry's CONTENT is rewritten, only when entries are added/removed/
 * renamed, so `.arch`'s stat alone never moves. Walking into `.arch` stats the
 * file itself, whose (mtimeNs, size, ino) does move. Symlinks are statted, not
 * followed, and a per-dir read error is swallowed (its absence is the change).
 */
function scanBoardDir(dir: string): DirScan {
  const now = Date.now();
  const cached = dirScanCache.get(dir);
  if (cached && now - cached.at < SCAN_TTL_MS) return cached;
  const files = new Map<string, string>();
  let dirStat = 'absent'; // a removed dir reads 'absent'; a recreate reads a fresh ino
  try {
    const st = fs.statSync(dir, { bigint: true });
    dirStat = `${st.mtimeNs}:${st.ctimeNs}:${st.ino}`;
    walk(dir, '', files);
  } catch { /* dir missing/removed — 'absent' dirStat, empty files */ }
  const scan: DirScan = { at: now, dirStat, files };
  dirScanCache.set(dir, scan);
  return scan;
}

/** Recursive directory walk collecting rel-path → (mtimeNs, size, ino). */
function walk(root: string, rel: string, out: Map<string, string>): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { walk(root, childRel, out); continue; }
    try { out.set(childRel, fileFp(fs.statSync(path.join(root, childRel), { bigint: true }))); }
    catch { /* entry vanished mid-scan — its absence is itself a change next poll */ }
  }
}

/** The named store files inside a data dir, each statted, cached ~1s. */
function statStoreFiles(dataDir: string, names: string[]): Map<string, string> {
  const now = Date.now();
  const cached = fileStatCache.get(dataDir);
  if (cached && now - cached.at < SCAN_TTL_MS) return cached.stats;
  const stats = new Map<string, string>();
  for (const name of names) {
    try { stats.set(name, fileFp(fs.statSync(path.join(dataDir, name), { bigint: true }))); }
    catch { stats.set(name, 'absent'); }
  }
  fileStatCache.set(dataDir, { at: now, stats });
  return stats;
}

function hash(...parts: string[]): string {
  const h = createHash('sha256');
  for (const p of parts) { h.update(p); h.update('\x00'); }
  return h.digest('base64url').slice(0, 22);
}

/** Hash the board dir scan into one short fingerprint, entries sorted for stability. */
function boardDirFingerprint(scan: DirScan): string {
  const h = createHash('sha256');
  h.update(scan.dirStat); h.update('\x00');
  for (const name of [...scan.files.keys()].sort()) {
    h.update(name); h.update('\x00'); h.update(scan.files.get(name)!); h.update('\x00');
  }
  return h.digest('base64url').slice(0, 22);
}

// All dataDir files the aggregate signal depends on. `access-requests.json` is a
// BOARD input (FEAT-200's access card leads needsYou) written temp+rename, so it
// must move the board fingerprint; it has no separate client poll of its own.
const STORE_FILES = ['agent-outcomes.json', 'lanes.json', 'group-seals.json', 'decisions.json', 'access-requests.json'];

/**
 * The aggregate snapshot the /api/versions endpoint returns (minus `boot`,
 * which the endpoint prepends). Each value is a short opaque fingerprint string;
 * the client only ever compares it `!==` against the previous poll's value.
 *
 * `methodologyDir` lets the board fingerprint fold in the WA-consolidation
 * needs-human findings (`$METHODOLOGY_DIR/.station/needs-human.json` + its acks),
 * which surface as board observations/needsYou on the methodology home project.
 * Folded into every project's board fp (an over-eager move is just a 304); pass
 * '' to skip when no methodology dir is configured.
 */
export function snapshot(dataDir: string, boards: { id: string; dir: string }[], methodologyDir = '', pendingTimeEpoch = 0): {
  outcomes: string;
  pending: string;
  board: Record<string, string>;
} {
  const f = statStoreFiles(dataDir, STORE_FILES);
  const outcomes = hash(f.get('agent-outcomes.json')!, String(outcomesBump));
  // `pending` = lanes + group seals (files) + the TIME-based readiness epoch, so a
  // group-close deadline or starvation bound elapsing with no file write still
  // moves it. It is also a board input (lane cards).
  const pending = hash(f.get('lanes.json')!, f.get('group-seals.json')!, String(pendingBump), String(pendingTimeEpoch));
  const decisionsFp = hash(f.get('decisions.json')!, String(decisionsBump));
  const accessFp = f.get('access-requests.json')!;
  // The methodology needs-human findings + acks (a fixed .station subpath).
  const methodologyFp = methodologyDir
    ? hash(statFileAbs(path.join(methodologyDir, '.station', 'needs-human.json')), statFileAbs(path.join(methodologyDir, '.station', 'needs-human-acks.json')))
    : 'none';
  const board: Record<string, string> = {};
  for (const { id, dir } of boards) {
    board[id] = hash(boardDirFingerprint(scanBoardDir(dir)), pending, decisionsFp, accessFp, methodologyFp, String(boardBump));
  }
  return { outcomes, pending, board };
}

/** Stat one absolute file into a fingerprint; 'absent' if it is missing. */
function statFileAbs(file: string): string {
  try { return fileFp(fs.statSync(file, { bigint: true })); }
  catch { return 'absent'; }
}

/** Test-only: drop the scan caches so a fixture's writes are seen immediately. */
export function _clearCache(): void {
  dirScanCache.clear();
  fileStatCache.clear();
}
