#!/usr/bin/env node
/**
 * Session-provenance unit verification (server-side half).
 *
 * Covers the record store, the write-once guarantee, the conservative
 * pre-existing fallback (the machine `Dispatch:` line vs a human ticket title),
 * resolveStartedBy precedence, and — critically — that the self-contained
 * data-dir resolution in session-provenance.mjs has NOT drifted from the
 * canonical src/lib/paths.ts#dataDir (the module replicates it so a dispatch
 * subprocess never needs the TS loader; this asserts they still agree).
 *
 * Runs entirely against an isolated CLAUDE_STATION_DATA scratch dir — never the
 * user's real store.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert/strict';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'orchard-provenance-'));
process.env.CLAUDE_STATION_DATA = scratch;

const {
  stationDataDir, provenanceDir, recordSessionProvenance, readSessionProvenance,
  loadProvenanceMap, looksAgentDispatched, resolveStartedBy, isSafeSessionId,
} = await import('../src/lib/session-provenance.mjs');
const paths = await import('../src/lib/paths.ts');

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log(`  ok  ${name}`); pass++; };

// --- drift guard: the mirror must match the canonical resolver -------------
ok('dataDir mirror matches paths.ts (isolated env)', stationDataDir() === paths.dataDir());
{
  const saved = process.env.CLAUDE_STATION_DATA;
  delete process.env.CLAUDE_STATION_DATA;
  const savedXdg = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = path.join(scratch, 'xdg');
  ok('dataDir mirror matches paths.ts (XDG fallback)', stationDataDir() === paths.dataDir());
  delete process.env.XDG_DATA_HOME;
  ok('dataDir mirror matches paths.ts (home fallback)', stationDataDir() === paths.dataDir());
  if (savedXdg != null) process.env.XDG_DATA_HOME = savedXdg;
  process.env.CLAUDE_STATION_DATA = saved;
}
ok('provenanceDir is under the data dir', provenanceDir() === path.join(scratch, 'session-provenance'));

// --- id safety --------------------------------------------------------------
ok('uuid is a safe id', isSafeSessionId('0b3f5c2a-1234-4abc-9def-0123456789ab'));
ok('path traversal rejected', !isSafeSessionId('../etc/passwd'));
ok('slash rejected', !isSafeSessionId('a/b'));
ok('empty rejected', !isSafeSessionId(''));

// --- record / read / write-once --------------------------------------------
const uid = '11111111-2222-4333-8444-555555555555';
ok('record writes a fresh agent record', recordSessionProvenance(uid, 'agent', { source: 'dispatch:anthropic' }) === true);
ok('read returns the record', readSessionProvenance(uid)?.startedBy === 'agent');
ok('write-once: second record is a no-op', recordSessionProvenance(uid, 'user') === false);
ok('write-once did NOT flip the value', readSessionProvenance(uid)?.startedBy === 'agent');
ok('invalid startedBy refused', recordSessionProvenance('66666666-7777-4888-8999-aaaaaaaaaaaa', 'robot') === false);
ok('unsafe id refused', recordSessionProvenance('../x', 'agent') === false);

const uuser = '99999999-8888-4777-8666-555544443333';
recordSessionProvenance(uuser, 'user', { source: 'agent-bridge' });
const map = loadProvenanceMap();
ok('loadProvenanceMap sees both', map.get(uid)?.startedBy === 'agent' && map.get(uuser)?.startedBy === 'user');

// --- the conservative pre-existing fallback --------------------------------
ok('real machine Dispatch line -> agent',
  looksAgentDispatched('Dispatch: ticket=BUG-099 phase=fixing round=2 class=fix\n\nDo the thing.'));
ok('Dispatch line collapsed to one line still -> agent (title normalisation)',
  looksAgentDispatched('Dispatch: ticket=BUG-099 phase=fixing round=2 class=fix  Do the thing.'));
ok('a human typing a ticket id is NOT agent',
  !looksAgentDispatched('BUG-099 is still broken, can you look at it?'));
ok('a human title that mentions dispatch is NOT agent',
  !looksAgentDispatched('the dispatch: system keeps timing out'));
ok('bare "dispatch:" with no declared field is NOT agent (errs toward showing)',
  !looksAgentDispatched('dispatch: please help'));
ok('empty/undefined first message is NOT agent', !looksAgentDispatched(null) && !looksAgentDispatched(''));

// --- resolveStartedBy precedence -------------------------------------------
ok('record wins over content', resolveStartedBy({
  sessionId: uuser, firstUserMessage: 'Dispatch: ticket=BUG-1 phase=fixing round=1 class=fix', record: map.get(uuser),
}) === 'user');
ok('no record + machine line -> agent (pre-existing fallback)', resolveStartedBy({
  sessionId: 'no-such-id-00000000-0000-4000-8000-000000000000',
  firstUserMessage: 'Dispatch: ticket=FEAT-1 phase=fixing round=1 class=fix',
}) === 'agent');
ok('no record + human text -> user (default shows)', resolveStartedBy({
  sessionId: 'no-such-id-11111111-0000-4000-8000-000000000000',
  firstUserMessage: 'hello can you help with BUG-1',
}) === 'user');
ok('nothing at all -> user', resolveStartedBy({}) === 'user');

fs.rmSync(scratch, { recursive: true, force: true });
console.log(`\nverify-session-provenance: ${pass} checks passed`);
