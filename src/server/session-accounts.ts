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
 *   - READER: the `AgentSession` constructor — the single spawn chokepoint every
 *     resume flows through — forces the resumed session's effective account to
 *     the bound value, so NO resume route can run a switched session on the old
 *     account, whatever override a client carries.
 *
 * A session that was never switched has NO binding (`getSessionAccount` →
 * `undefined`), so its account stays the per-launch override exactly as FEAT-145
 * defines. This module is purely additive to that model.
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

/** Bind this session to an account, durably, so every later resume reads it. */
export function setSessionAccount(sid: string, account: BoundAccount): void {
  if (!validSessionId(sid)) throw new Error(`setSessionAccount: not a valid session id: ${String(sid)}`);
  const map = load();
  map.set(sid, account);
  persist(map);
}

/**
 * FEAT-160 round 4 — for a RESUME or an outbox enqueue of a session the server
 * already owns the account for (a binding exists), the client-carried
 * `claudeAccount` is NOT a request: the binding decides at the single spawn
 * chokepoint (the `AgentSession` constructor reads it). So the server must
 * neither READ nor VALIDATE the client value for a bound session — a stale tab
 * still carrying an account that has since been DELETED would otherwise fatally
 * strand the resume on `validateSessionOverrides` ("claudeAccount must be null or
 * the id of an existing account"), even though the server owns the account for
 * that session. This is the exact reason a resume already DROPS the client's
 * `provider` (BUG-196): a fact the server owns must not be killable by a stale
 * client value. An UNBOUND session is returned untouched — its per-launch
 * `claudeAccount` is the legitimate FEAT-145 launch override and is validated as
 * before. Returns the overrides with `claudeAccount` removed (or `undefined` if
 * nothing is left), so every resume/enqueue site strips it the same way.
 */
export function dropBoundAccountOverride(
  sid: string | null | undefined,
  overrides: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  if (!overrides || !('claudeAccount' in overrides) || getSessionAccount(sid) === undefined) {
    return overrides && Object.keys(overrides).length ? overrides : undefined;
  }
  const { claudeAccount: _dropped, ...rest } = overrides;
  return Object.keys(rest).length ? rest : undefined;
}

/** Test seam: drop the in-memory cache so the next read reloads from disk. */
export function _resetSessionAccountsCache(): void {
  cache = null;
}
