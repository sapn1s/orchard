/**
 * FEAT-151 — read the Claude runtime versions Orchard actually uses, and update
 * the HOST runtime on demand.
 *
 * WHY THIS MODULE EXISTS. A user's sessions failed with "Claude Code <old> does
 * not support this model; version <new> is required". Running `claude update` on
 * the host did nothing, because Orchard does NOT run the host's `claude`:
 *
 *  - HOST (isolation:direct) sessions run the CLI BUNDLED INSIDE the Agent SDK
 *    package (`@anthropic-ai/claude-agent-sdk`). The SDK's `query()` spawns
 *    `require.resolve('@anthropic-ai/claude-agent-sdk-<platform>/claude')` — a
 *    binary version-LOCKED to the installed SDK package. Updating it means
 *    `npm install @anthropic-ai/claude-agent-sdk@<v>`, NOT `claude update`.
 *  - CONTAINER sessions run a separate `@anthropic-ai/claude-code` baked into the
 *    per-project image — see container-manager.ts / provision.json.
 *
 * THE ONE HARD RULE (openai review finding #1): SDK JS and CLI ship
 * version-locked, and the SDK JS is import-cached in THIS running process. An
 * `npm install` replaces the JS + binary ON DISK but not IN MEMORY, so a session
 * spawned after an update would pair the NEW on-disk binary with the OLD
 * in-memory SDK JS — an unsupported skew. Therefore an update is NOT a hot swap:
 * it writes the new package and then BLOCKS new host sessions until a restart
 * reconciles the loaded JS with the disk.
 *
 * HOW THE BLOCK IS DECIDED (round-4 design): the runtime IDENTITY is
 * {SDK version, platform-package version, sha256 of the bundled binary's
 * CONTENTS}, and every admission compares the current on-disk identity to the
 * one proven at boot. The pending state is DERIVED from that comparison, not a
 * sticky flag:
 *   - BOOT PROVES THE RUNTIME RUNS (round-4 defect #1): once at boot, and only
 *     off the admission path, Orchard runs `claude --version` AND hashes the
 *     binary. Until that proof completes admission fails closed ("runtime check
 *     pending"); if it fails it fails closed forever ("runtime check failed …").
 *     A binary that merely EXISTS with its exec bit set but does not RUN never
 *     becomes a good baseline (the round-3 break: a broken boot binary was
 *     captured as a coherent {sdk,plat,size} baseline and sessions admitted).
 *   - THE CACHE KEY COVERS EVERY INPUT (round-4 defect #2, round-6 ctime): the
 *     identity cache is keyed on the stat identity (dev:ino:size:mtime:ctime) of the
 *     binary AND both package.jsons, so a package.json that changes or vanishes while
 *     the binary is untouched forces a recompute instead of returning a stale
 *     identity. ctime is in the key (round-6) so a same-size in-place overwrite that
 *     RESTORES the original mtime still moves the key and re-hashes — mtime alone can
 *     be forged with `utimes`, ctime cannot.
 *   - CONTENT, NOT SIZE (round-4 defect #3): the binary is compared by sha256 of
 *     its contents, so a same-SIZE corrupted/swapped binary no longer matches. A
 *     same-version reinstall (fresh inode/mtime, identical bytes) hashes
 *     identically, so a revert re-admits with no restart (defect #3, preserved).
 *     Hashing a 237 MB binary is ~200 ms of work, so it is STREAMED and async and
 *     runs only when the binary's stat key changed; while a hash is in flight
 *     admission fails closed ("checking runtime"). The admission path itself
 *     NEVER spawns and never hashes when the stat key is unchanged — a fs stat +
 *     two cached package.json reads (round-3 defect: no per-admission spawn).
 *
 * Four version facts, each read from exactly ONE authority (ARCH-010):
 *   1. running host SDK  — BOOT_SDK_VERSION, the SDK package.json version read
 *      ONCE at boot; this is the JS today's sessions actually use.
 *   2. installed host SDK — read at request time from node_modules (disk).
 *      installed != boot  ⇒ restartPending.
 *   3. latest published   — the npm registry, best-effort, short-cached.
 *   4. container image CLI — the image label (container-manager.ts), whose target
 *      is the CLI the CURRENT host SDK bundles (probed, never computed).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { projectRoot } from '../../lib/paths.ts';

const SDK_PKG = '@anthropic-ai/claude-agent-sdk';
const CLI_PKG = '@anthropic-ai/claude-code';

/**
 * An exact, STRICT semver, and nothing else: no ranges, tags, aliases, URLs,
 * dist-tags. This is the canonical semver.org grammar — numeric identifiers
 * carry no leading zeros and pre-release/build identifiers may not be empty — so
 * it rejects `01.2.3`, `1.2.3-01` and `1.2.3-a..b`, none of which npm accepts
 * either. Its job is to keep anything but a fixed version off the `npm install`
 * command line; strict-semver is the honest expression of that.
 */
export const EXACT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/* ---------------------------------------------------------------- on disk */

function sdkPackageJsonPath(): string {
  return path.join(projectRoot(), 'node_modules', SDK_PKG, 'package.json');
}

/** The SDK package version currently on disk (request-time truth). null = absent. */
export function installedSdkVersion(): string | null {
  try {
    const j = JSON.parse(fs.readFileSync(sdkPackageJsonPath(), 'utf8')) as { version?: string };
    return typeof j.version === 'string' ? j.version : null;
  } catch {
    return null;
  }
}

/**
 * The SDK's bundled CLI binary, resolved WITHOUT platform arithmetic: the SDK
 * ships one optional dep `@anthropic-ai/claude-agent-sdk-<platform>-<arch>[-musl]`
 * containing a `claude` executable, and exactly one of them is installed for
 * this machine. Enumerate them and take the one that is actually present, so a
 * new platform tuple (or musl) needs no code change here.
 */
export function bundledCliPath(): string | null {
  const scope = path.join(projectRoot(), 'node_modules', '@anthropic-ai');
  let names: string[];
  try {
    names = fs.readdirSync(scope);
  } catch {
    return null;
  }
  for (const name of names) {
    if (name === 'claude-agent-sdk' || !name.startsWith('claude-agent-sdk-')) continue;
    const bin = path.join(scope, name, 'claude');
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      return bin;
    } catch {
      /* not this one */
    }
  }
  return null;
}

interface CachedVersion { at: number; value: string | null; }
let bundledCliCache: CachedVersion | null = null;

/**
 * The bundled CLI's own `--version` — the AUTHORITY for "which CLI does today's
 * host SDK run", and therefore the target a container pin must track (finding
 * #7: never string-arithmetic on the SDK version). Async-deadline-bounded and
 * short-cached so it never blocks an HTTP handler for long; `spawnSync` here is
 * fine because it is capped at 5s and cached for 60s (NOT the 60s
 * `probeInstalledVersion` blast).
 */
export function bundledCliVersion(opts: { force?: boolean } = {}): string | null {
  const now = Date.now();
  if (!opts.force && bundledCliCache && now - bundledCliCache.at < 60_000) return bundledCliCache.value;
  let value: string | null = null;
  const bin = bundledCliPath();
  if (bin) {
    try {
      const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 5_000 });
      const raw = (String(r.stdout ?? '') + String(r.stderr ?? '')).trim();
      const m = raw.match(/(\d+\.\d+\.\d+[-.\w]*)/);
      if (!r.error && r.status === 0 && m) value = m[1]!;
    } catch {
      value = null;
    }
  }
  bundledCliCache = { at: now, value };
  return value;
}

/* ------------------------------------- boot vs disk runtime identity (skew) */

/**
 * The runtime IDENTITY — the fixed point the admission guard compares against.
 * The version-locked facts a NEW host session must still match:
 *   - `sdkVersion`  — the main SDK package.json version (the loaded JS).
 *   - `platVersion` — the bundled platform package's OWN package.json version.
 *     The CLI binary lives in a SEPARATE optional dep
 *     (`@anthropic-ai/claude-agent-sdk-<platform>`) whose package.json version
 *     is bumped in lockstep with the SDK by npm; a partial install that swaps
 *     the platform package shows here.
 *   - `hash`        — sha256 of the bundled `claude` binary's CONTENTS. This is
 *     the honest binary-change signal (round-4 defect #3): a same-SIZE corrupted
 *     or swapped binary hashes differently, while a revert to the SAME version
 *     (fresh inode/mtime, identical bytes) hashes identically — so a legitimate
 *     revert still re-admits (defect #3). Verified with a real npm install:
 *     0.3.280 and 0.3.281 have distinct sha256s, and reinstalling 0.3.280 after
 *     a bump restores its exact sha256 under a fresh inode.
 */
export interface RuntimeIdentity {
  sdkVersion: string;
  platVersion: string;
  hash: string;
}

/**
 * The bundled CLI's `claude` binary path, or null when no executable binary is
 * present (missing OR not executable — both mean the runtime the guard protects
 * cannot be read, i.e. skew).
 */
function bundledPlatformBin(): string | null {
  return bundledCliPath();
}

/**
 * The full stat identity of a file — dev:ino:size:mtime:ctime — used BOTH as the
 * identity/hash CACHE key and as the swap-detection identity in the boot proof→hash
 * TOCTOU and the admission re-hash. Every field a change to the file would move is
 * present:
 *   - `ctime` is included deliberately (FEAT-151 round-6): any content OR metadata
 *     change advances it, and unlike mtime it CANNOT be forged with `utimes` (only a
 *     wall-clock roll-back would). Without it, a same-inode, same-SIZE in-place
 *     overwrite that RESTORES the original mtime (`utimes`/`utimensat`, or a
 *     mtime-preserving copy tool) leaves dev:ino:size:mtime unchanged — a stale cache
 *     hit that admitted a changed, non-running binary (round-5 verdict). With ctime in
 *     the key that overwrite moves the key, forcing a re-hash that then fails closed.
 *   - defect #3 is preserved: a legitimate same-version revert gets a FRESH inode
 *     (npm rename-over), so the key moves regardless of ctime, the binary re-hashes,
 *     and the identical content hash re-admits with no restart. An UNCHANGED binary
 *     has a stable ctime, so admissions stay pure cache hits (no per-admission
 *     re-hash). Both swap classes move at least one field: a rename-over moves the
 *     inode; an in-place write moves mtime+ctime. */
function statKey(st: fs.Stats): string {
  return `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
}

function readJsonVersion(p: string): string | null {
  try {
    const v = (JSON.parse(fs.readFileSync(p, 'utf8')) as { version?: string }).version;
    return typeof v === 'string' && v ? v : null;
  } catch {
    return null;
  }
}

/**
 * Streamed sha256 of a file's CONTENTS, async — never stalls the event loop on
 * the 237 MB binary (~200 ms of work, yielded across stream chunks). Resolves
 * null on any read error so the caller fails closed.
 */
function hashFile(p: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const h = createHash('sha256');
      const s = fs.createReadStream(p);
      s.on('error', () => resolve(null));
      s.on('data', (d) => h.update(d as Buffer));
      s.on('end', () => resolve(h.digest('hex')));
    } catch {
      resolve(null);
    }
  });
}

/**
 * Async `claude --version` PROOF — resolves the reported version iff the binary
 * actually RUNS (exit 0 + a parseable version), else null. Off any hot path
 * (boot only); a binary that exists with its exec bit but does not run resolves
 * null and never becomes a baseline (round-4 defect #1).
 */
function probeVersionAsync(bin: string, timeoutMs = 5_000): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: string | null) => { if (!done) { done = true; resolve(v); } };
    try {
      const c = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      const to = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* */ } finish(null); }, timeoutMs);
      c.stdout.on('data', (d) => { out += String(d); });
      c.stderr.on('data', (d) => { out += String(d); });
      c.on('error', () => { clearTimeout(to); finish(null); });
      c.on('close', (code) => {
        clearTimeout(to);
        const m = out.match(/(\d+\.\d+\.\d+[-.\w]*)/);
        finish(code === 0 && m ? m[1]! : null);
      });
    } catch {
      finish(null);
    }
  });
}

/* --- binary-content hash cache (keyed on the binary's stat identity) --- */
interface HashCache { binKey: string; hash: string; }
let hashCache: HashCache | null = null;
let hashInFlightKey: string | null = null;
let hashInFlightPromise: Promise<void> | null = null;

/* --- composite identity cache (keyed on binary + BOTH package.jsons) --- */
interface IdentityCache { key: string; identity: RuntimeIdentity | null; }
let identityCache: IdentityCache | null = null;

/**
 * Ensure the current binary's content hash is cached. Re-hashes ONLY when the
 * binary's stat key changed (round-4 design: hash at boot, re-hash on stat
 * change), asynchronously and single-flighted, then caches under the new key.
 *
 * TOCTOU (round-5): the hash is only cached when the SAME file underlay it start
 * to finish — the binary's `statKey` (dev:ino:size:mtime:ctime) is captured before
 * and after the read and must be unchanged AND equal to the caller's `binKey`. A swap
 * mid-hash moves the inode (rename) or mtime/ctime (in-place), so the result is
 * DISCARDED rather than cached under a key it does not belong to; the next
 * admission re-stats, gets the new key, and re-hashes — admission stays fail-closed
 * ("checking") until a stable hash lands. A hash bound to a file that changed under
 * it is never trusted.
 */
function ensureHash(bin: string, binKey: string): Promise<void> {
  if (hashCache && hashCache.binKey === binKey) return Promise.resolve();
  if (hashInFlightKey === binKey && hashInFlightPromise) return hashInFlightPromise;
  hashInFlightKey = binKey;
  hashInFlightPromise = (async () => {
    let before: fs.Stats | null = null;
    try { before = fs.statSync(bin); } catch { before = null; }
    const hash = before && statKey(before) === binKey ? await hashFile(bin) : null;
    let after: fs.Stats | null = null;
    try { after = fs.statSync(bin); } catch { after = null; }
    const stable =
      hash != null && before != null && after != null &&
      statKey(before) === statKey(after) && statKey(before) === binKey;
    if (stable) hashCache = { binKey, hash };
    identityCache = null; // force identity rebuild (whether or not the hash was accepted)
    if (hashInFlightKey === binKey) { hashInFlightKey = null; hashInFlightPromise = null; }
  })();
  return hashInFlightPromise;
}

interface CurrentIdentity { identity: RuntimeIdentity | null; checking: boolean; }

/**
 * Read the current on-disk runtime identity with fs ONLY (no spawn on this hot
 * path). The cache key covers EVERY input (round-4 defect #2): the stat identity
 * of the binary AND both package.jsons, so a change to any of them — including a
 * package.json that changes or vanishes while the binary is untouched — forces a
 * recompute rather than returning a stale identity. The binary is compared by
 * CONTENT (round-4 defect #3): its sha256 is computed ASYNCHRONOUSLY and cached
 * under the binary's stat key; while a hash is in flight this returns
 * `checking:true` so admission fails closed rather than stalling on a 200 ms
 * hash. Any read/stat failure yields `{ identity: null }` (fail closed).
 */
function readCurrentIdentity(): CurrentIdentity {
  const bin = bundledPlatformBin();
  if (!bin) return { identity: null, checking: false }; // no executable binary → fail closed
  const sdkPkg = sdkPackageJsonPath();
  const platPkg = path.join(path.dirname(bin), 'package.json');
  let bst: fs.Stats, platSt: fs.Stats, sdkSt: fs.Stats;
  try { bst = fs.statSync(bin); } catch { return { identity: null, checking: false }; }
  try { platSt = fs.statSync(platPkg); } catch { return { identity: null, checking: false }; }
  try { sdkSt = fs.statSync(sdkPkg); } catch { return { identity: null, checking: false }; }
  const binKey = statKey(bst);
  const compositeKey = `${binKey}|${statKey(platSt)}|${statKey(sdkSt)}`;
  if (identityCache && identityCache.key === compositeKey) return { identity: identityCache.identity, checking: false };

  // The binary's content hash is the only expensive input. Reuse it while the
  // binary's stat key is unchanged; otherwise re-hash async and fail closed
  // ("checking") until it lands.
  if (!hashCache || hashCache.binKey !== binKey) {
    void ensureHash(bin, binKey);
    return { identity: null, checking: true };
  }
  const platVersion = readJsonVersion(platPkg);
  const sdkVersion = installedSdkVersion();
  const identity: RuntimeIdentity | null =
    platVersion != null && sdkVersion != null ? { sdkVersion, platVersion, hash: hashCache.hash } : null;
  identityCache = { key: compositeKey, identity };
  return { identity, checking: false };
}

/** The current on-disk runtime identity, or null if unreadable/incoherent or a
 *  content hash is still in flight. Sync, fs-only, no spawn. */
export function currentRuntimeIdentity(): RuntimeIdentity | null {
  return readCurrentIdentity().identity;
}

/**
 * The SDK JS ACTUALLY LOADED by this process — captured once, at module load
 * (retained for the panel's "running SDK" display).
 */
export const BOOT_SDK_VERSION: string | null = installedSdkVersion();

/**
 * The runtime facts captured ONCE at boot, but ONLY after PROVING the bundled
 * binary actually RUNS (round-4 defect #1). Both are live ESM bindings, `null`
 * until the async boot check completes:
 *   - `BOOT_CLI_VERSION` — the `--version` the bundled binary reports (display).
 *   - `BOOT_IDENTITY`     — {sdkVersion, platVersion, sha256 hash}, the fixed
 *     comparison point. Set ONLY when `--version` ran AND the hash + both
 *     versions were read; a binary that exists with its exec bit but does not
 *     run leaves `bootState='failed'` and BOOT_IDENTITY null forever (a failed
 *     check is never promoted to a baseline).
 */
export let BOOT_CLI_VERSION: string | null = null;
export let BOOT_IDENTITY: RuntimeIdentity | null = null;
let bootState: 'pending' | 'ok' | 'failed' = 'pending';
let bootFailReason: string | null = null;

const bootChecked: Promise<void> = (async () => {
  const bin = bundledPlatformBin();
  if (!bin) { bootState = 'failed'; bootFailReason = 'the bundled runtime binary is missing or not executable'; return; }
  // The run-proof, the content hash and the trusted identity must all bind to ONE
  // file (round-5 TOCTOU fix). A binary swapped between the proof (T1) and the hash
  // (T2) would otherwise let a NON-running binary's hash become the baseline: the
  // proof runs the good (unlinked) inode while the hash reads the swapped path. So
  // capture `statKey` before the proof and again after the hash and require it
  // unchanged; if it moved, the two straddled different files — retry a bounded
  // number of times, then fail CLOSED. statKey (dev:ino:size:mtime:ctime) moves for
  // both swap classes: a rename-over changes the inode, an in-place write changes
  // mtime/ctime (ctime cannot be forged with utimes).
  const MAX_TRIES = 3;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    let stBefore: fs.Stats;
    try { stBefore = fs.statSync(bin); } catch { bootState = 'failed'; bootFailReason = 'the bundled runtime binary could not be read'; return; }
    // (1) PROVE it runs — the whole point of round 4's defect #1 fix.
    const cliVer = await probeVersionAsync(bin);
    if (cliVer == null) { bootState = 'failed'; bootFailReason = 'the bundled runtime did not run `--version` at boot'; return; }
    // (2) content hash (once, at boot).
    const hash = await hashFile(bin);
    if (hash == null) { bootState = 'failed'; bootFailReason = 'the bundled runtime binary could not be hashed at boot'; return; }
    // (2b) prove the proof and the hash saw the SAME file: re-stat and require the
    // full identity unchanged across probe+hash. If it moved, discard and retry.
    let stAfter: fs.Stats | null = null;
    try { stAfter = fs.statSync(bin); } catch { stAfter = null; }
    if (stAfter == null || statKey(stBefore) !== statKey(stAfter)) {
      continue; // the binary changed under the boot check — the proof and the hash
                // may be different files; do NOT trust this hash. Retry.
    }
    // (3) versions.
    const platVersion = readJsonVersion(path.join(path.dirname(bin), 'package.json'));
    const sdkVersion = installedSdkVersion();
    if (platVersion == null || sdkVersion == null) { bootState = 'failed'; bootFailReason = 'the runtime package metadata could not be read at boot'; return; }
    BOOT_CLI_VERSION = cliVer;
    hashCache = { binKey: statKey(stAfter), hash }; // seed so the first admission is a pure cache hit
    BOOT_IDENTITY = { sdkVersion, platVersion, hash };
    bootState = 'ok';
    return;
  }
  // The binary kept changing across the check — never captured a coherent, proven
  // baseline. Fail closed (permanent until restart), not a torn baseline.
  bootState = 'failed';
  bootFailReason = 'the bundled runtime binary kept changing during the boot check';
})();

/** Resolves once the one-time boot runtime check has completed (ok or failed).
 *  Callers/tests await this before treating a "pending" block as meaningful. */
export function whenRuntimeChecked(): Promise<void> { return bootChecked; }

/** Resolves once the current identity has settled — no binary-content hash in
 *  flight. Used after a binary change (an update/revert) to await the async
 *  re-hash before reading the derived admission state. */
export async function whenRuntimeSettled(): Promise<void> {
  await bootChecked;
  for (let i = 0; i < 200; i++) {
    if (!readCurrentIdentity().checking) return;
    if (hashInFlightPromise) await hashInFlightPromise;
    else await new Promise((r) => setTimeout(r, 5));
  }
}

/** In-flight single-flight guard (finding #1 + the request-level 409). */
let updateInProgress = false;

/** `transient` (BUG-190 round 3): the block clears on its own — the boot check or a
 *  re-hash is still running — so a caller may retry; every other block needs a restart. */
interface Admission { blocked: boolean; reason: string | null; transient?: boolean; }
const RESTART_TAIL = 'Restart Orchard to apply; sessions already running are unaffected.';

/**
 * The single admission decision, DERIVED (never a sticky flag). Fails CLOSED on
 * every uncertain state, in order:
 *   - an update is installing in THIS process (half-replaced files);
 *   - the boot runtime check has not completed yet ("runtime check pending");
 *   - the boot runtime check FAILED — the binary did not run at boot
 *     ("runtime check failed: …"); a failed check never became a baseline;
 *   - the current binary changed and its content hash is still being computed
 *     ("checking runtime");
 *   - the current identity is unreadable/incoherent;
 *   - SDK and platform package versions disagree (a half-replaced install);
 *   - any of {sdkVersion, platVersion, content hash} differs from boot.
 * When the disk reverts to the boot identity (same versions + identical hash,
 * even with a fresh inode/mtime) this returns not-blocked and sessions re-admit
 * with no restart (defect #3): the signal is disk-derived, not a flag.
 */
function admission(): Admission {
  if (updateInProgress) {
    return { blocked: true, reason: `a runtime update is installing on disk. ${RESTART_TAIL}` };
  }
  if (bootState === 'pending') {
    return { blocked: true, transient: true, reason: 'runtime check pending — Orchard is verifying the bundled runtime; new host sessions can start once the check completes.' };
  }
  if (bootState === 'failed') {
    return { blocked: true, reason: `runtime check failed: ${bootFailReason ?? 'the bundled runtime did not pass its boot check'}. ${RESTART_TAIL}` };
  }
  const boot = BOOT_IDENTITY!; // non-null once bootState === 'ok'
  const cur = readCurrentIdentity();
  if (cur.checking) {
    return { blocked: true, transient: true, reason: 'checking runtime — the bundled runtime changed on disk and is being re-verified; new host sessions can start once the check completes.' };
  }
  const c = cur.identity;
  if (c == null) {
    return { blocked: true, reason: `the bundled runtime could not be read on disk. ${RESTART_TAIL}` };
  }
  if (c.sdkVersion !== c.platVersion) {
    return { blocked: true, reason: `a partly-replaced runtime (SDK ${c.sdkVersion} vs CLI package ${c.platVersion}). ${RESTART_TAIL}` };
  }
  if (c.sdkVersion !== boot.sdkVersion || c.platVersion !== boot.platVersion || c.hash !== boot.hash) {
    const parts: string[] = [];
    if (c.sdkVersion !== boot.sdkVersion) parts.push(`SDK ${boot.sdkVersion} → ${c.sdkVersion}`);
    if (c.platVersion !== boot.platVersion) parts.push(`CLI package ${boot.platVersion} → ${c.platVersion}`);
    else if (c.hash !== boot.hash) parts.push('the bundled CLI binary changed on disk');
    const what = parts.length ? ` (${parts.join('; ')})` : '';
    return {
      blocked: true,
      reason:
        `the Claude host runtime changed on disk${what} and ` +
        'Orchard must be restarted before new host sessions can start on it. ' +
        RESTART_TAIL,
    };
  }
  return { blocked: false, reason: null };
}

/**
 * Does the current disk runtime differ from / fail the boot baseline? (Content-
 * hash based, boot-proven.) Excludes the in-process `updateInProgress` flag,
 * which `isRuntimeUpdatePending` folds in. Fails closed on any uncertain state.
 */
export function identitySkew(): boolean {
  if (bootState !== 'ok') return true; // pending or failed → fail closed
  const boot = BOOT_IDENTITY;
  if (boot == null) return true;
  const cur = readCurrentIdentity();
  if (cur.checking || cur.identity == null) return true;
  const c = cur.identity;
  return (
    c.sdkVersion !== c.platVersion ||
    c.sdkVersion !== boot.sdkVersion ||
    c.platVersion !== boot.platVersion ||
    c.hash !== boot.hash
  );
}

/**
 * Is a runtime update pending a restart? DERIVED from disk each call (no
 * persistent file): the boot check state, the in-process install flag, and the
 * current on-disk identity vs boot. Fails closed on every uncertain state; a
 * disk that reverts to the boot identity re-admits with no restart (defect #3);
 * an admission never spawns and hashes only on a binary stat change (defect #2).
 */
export function isRuntimeUpdatePending(): boolean {
  return admission().blocked;
}

/**
 * The guard the session-start path calls (finding #1). Only HOST (direct)
 * sessions are blocked: container sessions run a separate baked CLI, and already
 * running sessions keep their in-memory runtime + already-spawned process. Built
 * from fs facts only — NO spawn on this hot path (round-3 defect #2).
 */
export function hostSessionBlockReason(): string | null {
  return admission().reason;
}

/**
 * BUG-190 round 3 — the same decision with its kind stated by its owner, so a
 * reader never has to infer "will this clear by itself?" from the prose.
 */
export function hostSessionBlock(): { reason: string; transient: boolean } | null {
  const a = admission();
  return a.blocked && a.reason ? { reason: a.reason, transient: a.transient === true } : null;
}

/* -------------------------------------------------------- npm registry */

interface LatestCache { at: number; sdk: string | null; cli: string | null; error: string | null; }
let latestCache: LatestCache | null = null;
const LATEST_TTL_MS = 60 * 60_000; // ~1h — opening Settings must not hammer npm.

async function fetchLatest(pkg: string): Promise<string> {
  const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, {
    signal: AbortSignal.timeout(5_000),
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`registry HTTP ${res.status} for ${pkg}`);
  const j = (await res.json()) as { version?: string };
  if (typeof j.version !== 'string' || !j.version) throw new Error(`registry gave no version for ${pkg}`);
  return j.version;
}

/**
 * Latest published SDK + CLI, best-effort and short-cached. NEVER throws to the
 * caller: on any network/registry error it returns an `error` string so the
 * panel renders "couldn't check latest" and still shows current versions
 * (finding — GET returns 200, never 500).
 */
export async function latestPublished(opts: { force?: boolean } = {}): Promise<{ sdk: string | null; cli: string | null; checkedAt: string | null; error: string | null }> {
  const now = Date.now();
  if (!opts.force && latestCache && now - latestCache.at < LATEST_TTL_MS) {
    return { sdk: latestCache.sdk, cli: latestCache.cli, checkedAt: new Date(latestCache.at).toISOString(), error: latestCache.error };
  }
  try {
    const [sdk, cli] = await Promise.all([fetchLatest(SDK_PKG), fetchLatest(CLI_PKG)]);
    latestCache = { at: now, sdk, cli, error: null };
    return { sdk, cli, checkedAt: new Date(now).toISOString(), error: null };
  } catch (err) {
    const error = (err as Error).message || 'could not reach the npm registry';
    latestCache = { at: now, sdk: null, cli: null, error };
    return { sdk: null, cli: null, checkedAt: new Date(now).toISOString(), error };
  }
}

/** Resolve a requested target to an exact version, or reject (finding #3). */
async function resolveTargetVersion(requested: string | undefined): Promise<string> {
  if (requested === undefined || requested === 'latest') {
    const latest = await latestPublished({ force: true });
    if (!latest.sdk) throw new Error(`cannot resolve "latest": ${latest.error ?? 'registry unreachable'}`);
    return latest.sdk;
  }
  if (!EXACT_SEMVER.test(requested)) {
    throw new Error(`invalid version ${JSON.stringify(requested)} — an exact semver like 0.3.281 is required (no ranges, tags, or URLs)`);
  }
  return requested;
}

/* ------------------------------------------------- the host SDK update */

function cmp3(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10));
  const pb = b.split('.').map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

export interface HostRuntimeInfo {
  runningSdk: string | null;
  runningCli: string | null;
  installedSdk: string | null;
  installedCli: string | null;
  restartPending: boolean;
  updateInProgress: boolean;
  bin: string | null;
}

export function hostRuntimeInfo(): HostRuntimeInfo {
  return {
    runningSdk: BOOT_SDK_VERSION,
    // runningCli is the CLI the LOADED SDK JS pairs with (captured at boot), NOT a
    // re-read of disk: today's sessions run that pairing regardless of what a
    // later partial install left on disk.
    runningCli: BOOT_CLI_VERSION,
    installedSdk: installedSdkVersion(),
    // installedCli is a FRESH disk read: across a pending update (or a swapped
    // binary) it can differ from runningCli, and that difference is exactly the
    // skew the guard now catches — so report it honestly rather than aliasing it
    // to runningCli.
    installedCli: bundledCliVersion({ force: true }),
    restartPending: isRuntimeUpdatePending(),
    updateInProgress,
    bin: bundledCliPath(),
  };
}

export interface UpdateResult {
  ok: boolean;
  installedSdk: string | null;
  restartRequired: boolean;
  fromSdk: string | null;
  targetSdk: string;
  rolledBack?: boolean;
  error?: string;
  log?: string;
  rollbackCommand?: string;
}

export class UpdateInProgressError extends Error {
  constructor() {
    super('a runtime update is already running');
    this.name = 'UpdateInProgressError';
  }
}

function runNpm(args: string[], cwd: string, onLog?: (s: string) => void): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    // Controlled env (finding #3): no lifecycle-script surprises beyond npm's
    // own, a bounded output buffer, and the same PATH the server runs with.
    const env: NodeJS.ProcessEnv = { ...process.env, npm_config_yes: 'true', NO_UPDATE_NOTIFIER: '1' };
    const child = spawn('npm', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const CAP = 64 * 1024; // bounded output buffer (finding #10)
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`npm ${args[0]} timed out`)); }, 10 * 60_000);
    const take = (d: unknown) => { const s = String(d); if (out.length < CAP) out += s.slice(0, CAP - out.length); onLog?.(s); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, out }); });
  });
}

/**
 * Install (pin) a new host SDK version and prove the artifact, or roll back.
 *
 * finding #4 — a REAL recovery design, not "npm restores it": snapshot
 * package.json + lock + the installed version BEFORE install; after install
 * VERIFY the package identity + exact version, the platform binary exists and
 * `--version` runs, and (in a CHILD process) that the SDK JS imports. On any
 * failure restore the snapshot and report the still-installed version + the
 * manual rollback command.
 *
 * Never restarts the server and never touches running sessions. Sets the
 * persistent pending state from the moment install starts (finding #1) so a new
 * host session cannot spawn against half-replaced files.
 */
export async function updateHostRuntime(opts: { version?: string; onLog?: (s: string) => void } = {}): Promise<UpdateResult> {
  if (updateInProgress) throw new UpdateInProgressError();
  updateInProgress = true;
  const root = projectRoot();
  const pkgPath = path.join(root, 'package.json');
  const lockPath = path.join(root, 'package-lock.json');
  const fromSdk = installedSdkVersion();
  const rollbackCommand = `cd ${root} && npm install`;

  // Snapshot BEFORE anything is validated or run.
  let pkgSnap: string | null = null;
  let lockSnap: string | null = null;
  try { pkgSnap = fs.readFileSync(pkgPath, 'utf8'); } catch { pkgSnap = null; }
  try { lockSnap = fs.readFileSync(lockPath, 'utf8'); } catch { lockSnap = null; }

  const restoreSnapshot = () => {
    try { if (pkgSnap != null) fs.writeFileSync(pkgPath, pkgSnap); } catch { /* reported below */ }
    try { if (lockSnap != null) fs.writeFileSync(lockPath, lockSnap); } catch { /* reported below */ }
  };

  try {
    const target = await resolveTargetVersion(opts.version);
    const spec = `${SDK_PKG}@${target}`;

    // The live-install window is guarded by `updateInProgress` (set above): new
    // host sessions are blocked from the moment install starts (finding #1). No
    // persistent pending file is written — after install, isRuntimeUpdatePending()
    // DERIVES the answer from the on-disk identity vs boot (defect #3): a success
    // leaves disk != boot (blocked until restart), a rollback restores disk == boot
    // (re-admitted), with nothing to reconcile mid-process.

    // finding #3 — install the FIXED package name at that EXACT version, pinned
    // (--save-exact) into package.json, preferring --ignore-scripts.
    const baseArgs = ['install', '--save-exact', spec];
    opts.onLog?.(`[runtime] npm ${['install', '--save-exact', '--ignore-scripts', spec].join(' ')}\n`);
    let r = await runNpm(['install', '--save-exact', '--ignore-scripts', spec], root, opts.onLog);
    if (r.code !== 0) throw new Error(`npm install ${spec} failed (exit ${r.code})\n${r.out.trim().slice(-2000)}`);

    // finding #3 — VERIFY the platform binary still landed; only if it did NOT do
    // we drop --ignore-scripts and retry (the binary is a plain file in an
    // optional dep, so it normally lands regardless).
    if (!bundledCliPath()) {
      opts.onLog?.(`[runtime] platform binary missing after --ignore-scripts; retrying with scripts\n`);
      r = await runNpm([...baseArgs], root, opts.onLog);
      if (r.code !== 0) throw new Error(`npm install ${spec} (with scripts) failed (exit ${r.code})\n${r.out.trim().slice(-2000)}`);
    }

    // finding #4 — prove the artifact, do not trust the exit code.
    const disk = installedSdkVersion();
    if (disk !== target) throw new Error(`install reported success but node_modules SDK is ${disk ?? 'absent'}, not ${target}`);
    const bin = bundledCliPath();
    if (!bin) throw new Error(`install succeeded but the platform binary (bundled claude) is missing`);
    const ver = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000 });
    if (ver.error || ver.status !== 0) throw new Error(`the bundled claude at ${bin} does not run --version after install`);
    // Prove the SDK JS imports IN A CHILD (never in-process — that would load the
    // new JS into the running server, the exact skew we refuse).
    const imp = spawnSync(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(SDK_PKG)}).then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(3)})`], { cwd: root, encoding: 'utf8', timeout: 20_000 });
    if (imp.status !== 0) throw new Error(`the newly installed SDK JS fails to import: ${(imp.stderr || '').trim().slice(-400)}`);

    return { ok: true, installedSdk: disk, restartRequired: isRuntimeUpdatePending(), fromSdk, targetSdk: target, rollbackCommand };
  } catch (err) {
    // Release the single-flight BEFORE computing the reported state, so a failed
    // (rolled-back) update reports restartRequired honestly rather than inheriting
    // this call's own in-flight flag. `finally` still resets it (idempotent).
    updateInProgress = false;
    restoreSnapshot();
    // The snapshot restore reverts package.json/lock; node_modules may still hold
    // a partially-updated tree. isRuntimeUpdatePending() re-derives the answer from
    // the on-disk identity: if the restore returned disk to the boot identity,
    // sessions are re-admitted; if a partial tree remains, it stays blocked. Await
    // the async re-hash first so restartRequired is settled (not "checking").
    await whenRuntimeSettled();
    const stillInstalled = installedSdkVersion();
    return {
      ok: false,
      installedSdk: stillInstalled,
      restartRequired: isRuntimeUpdatePending(),
      fromSdk,
      targetSdk: opts.version ?? 'latest',
      rolledBack: true,
      error: (err as Error).message,
      log: (err as Error).message,
      rollbackCommand,
    };
  } finally {
    updateInProgress = false;
  }
}

/** Assemble the host half of GET /api/runtime/version, plus update-available. */
export async function runtimeVersionPayload(): Promise<{
  host: HostRuntimeInfo & { updateAvailable: boolean };
  latest: { sdk: string | null; cli: string | null; checkedAt: string | null; error: string | null };
}> {
  const host = hostRuntimeInfo();
  const latest = await latestPublished();
  const updateAvailable = !!(latest.sdk && host.installedSdk && cmp3(latest.sdk, host.installedSdk) > 0);
  return { host: { ...host, updateAvailable }, latest };
}

export { cmp3 as compareVersions };
