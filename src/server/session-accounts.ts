/**
 * FEAT-160 — the server-owned session→account binding.
 *
 * THE FACT THIS OWNS: "which Claude account is this session on." Before this
 * module, that fact had no owner: it lived ONLY in each browser tab's
 * `state.overrides` and was frozen into each outbox row at enqueue, so every
 * resume route (the ws `start` resume, the outbox pump's `resume` route, a
 * "Send anyway" on an uncertain row, a boot re-pump) re-derived the account
 * from whatever client-carried value it happened to hold. That is the ARCH-010
 * defect a live account switch kept tripping over (FEAT-160 rounds 1-2 + the
 * round-3 plan review): the switch reaped the old CLI, but a stale override on
 * another tab, or a row queued during the reap, resumed the SAME session id
 * under the OLD account — the exact mis-bill the feature exists to prevent.
 *
 * THE REMEDY (ARCH-010): one owner, written once, read once.
 *   - WRITER: the `switch-account` handler calls `setSessionAccount` durably
 *     BEFORE it reaps the old CLI.
 *   - READER: launch-account.ts `effectiveLaunchAccount` (BUG-255 r4) — the one
 *     authority every spawn (the AgentSession constructor) and the indicator's
 *     declared fact call. A binding decides a `direct` session's account; a
 *     container project's sessions use the project account.
 *
 * A session that was never switched has NO binding (`getSessionAccount` →
 * `undefined`) and launches on its project's account. A NEW session's pick is
 * written here as its binding at `system:init` (agent-bridge).
 *
 * Durability: the binding is written before the reap and persists across a
 * server restart (a crash between the reap and the client's re-resume must still
 * resume on the new account), so it is a small JSON file in the data dir, not
 * in-memory state. The file is keyed by the SDK session id (the transcript file
 * name), the one identifier every resume route already carries.
 */
import * as fs from 'node:fs';
import { sessionAccountsFile, writeAtomic } from '../lib/paths.ts';
import { validSessionId } from './outbox.ts';

/** `null` = the implicit default account (`~/.claude`); a string = a minted account id. */
export type BoundAccount = string | null;

/**
 * Cache keyed by the resolved file path, so a process that re-points
 * `CLAUDE_STATION_DATA` between operations (the in-process verify harnesses do)
 * never reads a stale binding from a previous data dir.
 */
let cache: { loadedFrom: string; map: Map<string, BoundAccount> } | null = null;

function load(): Map<string, BoundAccount> {
  const file = sessionAccountsFile();
  if (cache && cache.loadedFrom === file) return cache.map;
  const map = new Map<string, BoundAccount>();
  let raw: string | null = null;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { raw = null; }
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { bindings?: Record<string, BoundAccount> };
      const b = parsed && typeof parsed === 'object' ? parsed.bindings : undefined;
      if (b && typeof b === 'object') {
        for (const [sid, acct] of Object.entries(b)) {
          if (!validSessionId(sid)) continue;
          if (acct === null || typeof acct === 'string') map.set(sid, acct);
        }
      }
    } catch {
      // A truncated/garbled file (another process mid-write, a partial read):
      // degrade to "no bindings known" rather than crash. A binding is a safety
      // pin — losing one means a resume falls back to the client override, which
      // is the pre-FEAT-160 behaviour, never a wrong-account spend of its own.
    }
  }
  cache = { loadedFrom: file, map };
  return map;
}

function persist(map: Map<string, BoundAccount>): void {
  const bindings: Record<string, BoundAccount> = {};
  for (const [sid, acct] of map) bindings[sid] = acct;
  writeAtomic(sessionAccountsFile(), `${JSON.stringify({ bindings }, null, 2)}\n`);
}

/**
 * The account this session is bound to, or `undefined` if it was never switched
 * (the caller then uses the per-launch override — pre-FEAT-160 behaviour).
 * `{ account: null }` is a REAL binding to the default account and is distinct
 * from `undefined`: switching a session back to the default must stick too.
 */
export function getSessionAccount(sid: string | null | undefined): { account: BoundAccount } | undefined {
  if (!sid || !validSessionId(sid)) return undefined;
  const map = load();
  if (!map.has(sid)) return undefined;
  return { account: map.get(sid)! };
}

/**
 * Bind this session to an account, durably, so every later resume reads it.
 *
 * BUG-255 — PERSIST BEFORE PUBLISH. The disk write is the commit; the in-memory
 * cache is only a read-through copy of it. If we mutated the cache first and the
 * persist then threw, the handler would REFUSE the switch (it rethrows) while
 * every later in-process `getSessionAccount` read saw the new account — the
 * binding would be "live" in memory but absent on disk, so a restart would lose
 * it and, worse, the switch's own caller reported failure while the fact changed.
 * So: write the file first (on a COPY), and only publish the new value into the
 * cache once the write has succeeded. A throw leaves both disk and cache on the
 * old value, which is exactly what a refused switch must preserve.
 */
export function setSessionAccount(sid: string, account: BoundAccount): void {
  if (!validSessionId(sid)) throw new Error(`setSessionAccount: not a valid session id: ${String(sid)}`);
  const map = load();
  const next = new Map(map);
  next.set(sid, account);
  persist(next); // the commit — may throw (disk full, EACCES); if it does, the cache is untouched below
  map.set(sid, account); // publish into the live cache ONLY after the durable write succeeded
  // BUG-255 r2 — tell the owner of the declared account fact that the binding
  // changed, so every open tab is pushed the new fact (never only the requester).
  for (const cb of bindingObservers) {
    try { cb(sid); } catch (err) { console.error(`[orchard] BUG-255: binding observer failed: ${(err as Error).message}`); }
  }
}

/**
 * BUG-255 r3 — put a session's binding BACK to what it was before a switch that
 * did not happen (a live switch whose stop failed). `prev` is what
 * `getSessionAccount` returned before the switch: `undefined` removes the binding
 * (the session was never bound), `{account}` re-binds to it. Same discipline as
 * setSessionAccount: persist first, publish into the cache only after the write,
 * then notify the observers so every tab is pushed the restored fact.
 */
export function restoreSessionAccount(sid: string, prev: { account: BoundAccount } | undefined): void {
  if (prev !== undefined) { setSessionAccount(sid, prev.account); return; }
  if (!validSessionId(sid)) throw new Error(`restoreSessionAccount: not a valid session id: ${String(sid)}`);
  const map = load();
  if (!map.has(sid)) return;
  const next = new Map(map);
  next.delete(sid);
  persist(next);
  map.delete(sid);
  for (const cb of bindingObservers) {
    try { cb(sid); } catch (err) { console.error(`[orchard] BUG-255: binding observer failed: ${(err as Error).message}`); }
  }
}

/**
 * BUG-255 r2 — observers of a COMMITTED binding change (called after the durable
 * write and the cache publish). The server's account-fact publisher subscribes so
 * a rebind from any path reaches every tab, not just the request that made it.
 */
const bindingObservers = new Set<(sid: string) => void>();
export function onBindingChange(cb: (sid: string) => void): () => void {
  bindingObservers.add(cb);
  return () => { bindingObservers.delete(cb); };
}

/*
 * BUG-255 r4 — `dropBoundAccountOverride` is DELETED. It stripped a client's
 * `claudeAccount` only for BOUND sessions, so an unbound resume still launched on
 * the client's pick while the indicator showed the project account (verify r3).
 * A client pick is now never a launch override for an existing session:
 * launch-account.ts `takeAccountPick` removes it unread on every resume/enqueue
 * path, and `effectiveLaunchAccount` is the only decider.
 */

/** Test seam: drop the in-memory cache so the next read reloads from disk. */
export function _resetSessionAccountsCache(): void {
  cache = null;
}
