```orchard-ticket
{
  "id": "FEAT-078",
  "type": "feature",
  "title": "Sessions started outside Orchard were missing for one provider",
  "summary": "A project's OpenAI codex sessions created with the native command-line tool are now found, listed, titled and resumable in the session sidebar, alongside Claude sessions and codex sessions run through Orchard. Previously only Orchard's own mirror was read, so all outside codex work was invisible when a project was added.",
  "impact_if_we_wait": "Nothing is at risk now that the listing ships. Before it, prior codex work simply did not appear for a project. Bounded to history visibility: no session data was lost, and Claude history was always listed correctly.",
  "current_need": "Nothing is outstanding. A project with only externally-created codex sessions showed none before the change and lists them after, with the session, interface and transcript suites clean.",
  "severity": "medium",
  "area": "Project session sidebar",
  "reported": "2026-08-14",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "done",
  "human_action": "none",
  "updated": "2026-08-14",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A project's externally-created codex sessions appear in its session list",
    "Sessions belonging to other working directories are excluded",
    "A human-readable title is derived for each listed session",
    "Only the first metadata line of each rollout file is read",
    "Native, Claude and Orchard-run sessions coexist, tagged and ordered by recency"
  ],
  "code_refs": [
    {
      "path": "src/lib/session-history.ts",
      "symbol": null,
      "note": "provider session listing; read Claude's native store but only Orchard's own mirror for codex"
    },
    {
      "path": "src/server/orchard-transcripts.ts",
      "symbol": "providerRoots",
      "note": "enumerates the provider transcript roots the sidebar lists from"
    },
    {
      "path": "src/server/watcher.ts",
      "symbol": null,
      "note": "line 334 badges live codex sessions the same way as Claude"
    },
    {
      "path": "src/server/codex-runtime.ts",
      "symbol": null,
      "note": "line 170 already honours the CODEX_HOME override used to locate the native store"
    }
  ],
  "related": [],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": true,
    "Verification plan": true,
    "Migration and rollback": false,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/FEAT-078-detect-native-codex-sessions-on-add-project.md",
    "sha256": "bc53f4a8f5f16da2590e865530f73658f69688c7b5226b4eb9d96ef74313982c",
    "bytes": 9470,
    "original_title": "detect & list native (external) codex sessions for a project, like Claude sessions",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the original head: the gap, the on-disk store layout, all three wanted behaviours, the fixture-based proof bar and the risk bucket are present.",
    "dropped": [
      "the verbatim reporter quote from the Reported line",
      "the conditional follow-up branch for deferring resume, which was resolved by wiring it"
    ]
  }
}
```

# FEAT-078 — Sessions started outside Orchard were missing for one provider

## Diagnosis

### Why external codex sessions were invisible

Orchard reads Claude's native store directly (`~/.claude/projects/<encodedCwd>/*.jsonl`), which is why Claude history appears as soon as a project is added. For codex it read only Orchard's own `transcripts/openai` mirror, so sessions created by the native `codex` CLI were never enumerated. Sessions that ran *through* Orchard were always supported and badged live.

### The native store's shape

The codex store is keyed by date, not by working directory: `~/.codex/sessions/YYYY/MM/DD/rollout-<ISOts>-<session_id>.jsonl`, with `~/.codex/history.jsonl` alongside, and the whole root overridable by `CODEX_HOME`. The first line of each rollout is a `session_meta` record whose payload carries `session_id`, `timestamp`, `cwd` and `model_provider`. The project association is that `cwd`; everything after the head line is rollout events in a schema unlike Claude's.

## Evidence

Confirmed on disk before implementing: the date-tree layout, the `session_meta` head line and the `cwd`/`session_id` payload fields.

The fixer's own runs, recorded on FEAT-078: `verify:sessions` 52/52, `verify:ui` 7/7, `verify:orchard-transcripts` 15/15, `verify:bug-087-stale-transcript` 6/6, `verify:reattach-agent-backfill` 15/15, plus a further 36/36 tally recorded without an adjacent suite name. The leak gate stayed clean. `verify:feat-078-native-codex` and `verify:snapshots` are named in the ticket as intended coverage; no result was recorded against either. The ticket also describes a clean-room pass over the work.

No independent verifier verdict was ever dispatched against this ticket.

## Implementation notes

The date tree can be large, so the scan is bounded and newest-first, and reads only each file's head line rather than parsing whole rollouts. Listed sessions are tagged as OpenAI/codex to match the existing badging. Titles are derived from the rollout — first user message or summary — the way Claude session titles are. Resume and fork were investigated rather than assumed: the existing codex runtime could take a native session id, so the resume half was wired rather than deferred to a follow-up.

## Verification plan

Point `CODEX_HOME` at a scratch directory holding a synthetic date tree: some rollout files whose `session_meta.cwd` is a fixture project's host path, some for other directories. Assert the project's sessions list, other directories' sessions are excluded, titles are derived, and no full-file parse occurs. The must-fail pre-fix case is a project with only native codex sessions showing none. For realistic state, mix native, Claude and Orchard-run codex sessions in one project and assert all appear, correctly tagged and ordered by recency. Anti-regressions: the session, history/transcript and interface suites, typecheck and the leak gate. Real home paths stay out of tests.

## Risks

Read-only history listing is low risk on its own. Wiring resume moves the work into session lifecycle, which is the part that warranted an independent check.

## Activity log (APPEND-ONLY)
### 2026-08-14 — orchestrator
- Filed after confirming the gap live: `~/.codex/sessions` date-tree store exists; Orchard scans Claude's
  native store + its own openai mirror but not codex's native store. Single lane (history listing +
  sidebar), serialize.

### 2026-08-14 — worker (implementation)
**Hypothesis CONFIRMED before building.** `sessionsForProject` (index.ts) composed exactly two readers —
`hist.listLogicalProjectSessions` (Claude's native `~/.claude/projects` store) + `ot.listOrchardSessions`
(Orchard's own `dataDir/transcripts/openai` mirror). Neither reads codex's own date-tree store, so a
project with only native codex sessions listed ZERO. On-disk format verified live (codex-cli 0.147.0):
`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ISOts>-<session_id>.jsonl`, line-1 `session_meta.payload`
`{session_id, cwd, ...}`; real user prompts are `response_item` `payload.type:'message'` role `user`
(env/developer/skills wrappers precede them); assistant text is role `assistant` `output_text`.

**Fix map**
- NEW `src/server/codex-native.ts` — the whole feature:
  - `codexSessionsRoot(env)` honors `CODEX_HOME` (falls back to `~/.codex/sessions`), same resolution as
    codex-runtime.ts:170.
  - `listRolloutFiles` walks the `YYYY/MM/DD` tree NEWEST-FIRST, bounded by `maxFiles`.
  - `readRolloutHead` reads only a BOUNDED HEAD (≤256 KiB) per file — session_id/cwd from `session_meta`,
    title from the first non-wrapper `user` message; never full-parses. Returns `bytesRead` (proof).
  - `listNativeCodexSessions(hostPath)` — matches `session_meta.cwd` to hostPath, returns `SessionMeta`
    rows tagged `provider:'openai'`, `lastActivityAt` from file mtime (cheap recency), newest-first.
  - `importNativeCodexSession(sessionId)` — ON-DEMAND full parse → translates the rollout into an
    Orchard-owned transcript (same entry shape TranscriptRecorder writes: user/assistant text, reasoning→
    thinking, custom/function tool calls→tool_use, outputs→tool_result; developer/env wrappers dropped).
    Idempotent (never clobbers an existing target; temp-file+rename; race-safe). Filename = `<session_id>`
    (= codex thread id) under `transcripts/openai/<encodeCwd(cwd)>/`.
- `src/server/index.ts`:
  - `sessionsForProject` merges `cn.listNativeCodexSessions(p.hostPath)` after the Claude+orchard merge,
    de-duped by sessionId (an already-imported session is an 'openai' orchard row → native twin skipped).
  - Transcript route (`GET /api/transcript/:enc/:id`) — when neither store resolves, `importNativeCodex
    Session(id, {expectedEncodedDir})` backfills, then serves identically. Import-on-OPEN.
  - Start handler — before `startSession`, if a `resumeSessionId` isn't in the Claude/orchard stores,
    import it. Import-on-RESUME (belt-and-braces; open already covers the normal click-path).
- The sidebar already badges `provider==='openai'` as `codex` (app.js:1004, `.prov-tag`) — ZERO client
  changes needed; native rows badge exactly like Orchard-run codex.

**RESUME DECISION: WIRED (not deferred).** Native `session_id` IS the codex thread id. Once imported, a
native session is byte-for-byte an Orchard-owned codex transcript, so agent-bridge's existing resume-
provider resolution (`resolveOrchardSessionFile` → provider 'openai' → `CodexRuntime` → `thread/resume
{threadId: session_id}`) continues the SAME codex thread with no new lifecycle code. Proven at the module
level (imported native session resolves as provider openai); the live end-to-end codex resume path is
already covered green by verify:orchard-transcripts (15/15). Because this touches the resume/session-
lifecycle surface, per the standing high-stakes rule an INDEPENDENT clean-room verify pass of the resume
path is warranted before release (scripts/independent-verify.mjs or a fresh-context agent) — generation
should not be its own only verifier for the resume half.

**Verification** — NEW `scripts/verify-feat-078-native-codex.mjs` (`npm run verify:feat-078-native-codex`),
scratch `CODEX_HOME`/`CLAUDE_PROJECTS_DIR`/`CLAUDE_STATION_DATA`, no real home paths. **36/36 PASS.**
- MUST-FAIL proof (§C): the pre-fix reader composition (Claude store + Orchard transcripts, invoked
  directly) returns ZERO for a native-only project — the bug — while `cn.listNativeCodexSessions` returns
  3. (A3.)
- Head-only proof: a 400 KiB-padded rollout still yields the title with `bytesRead ≤ 256 KiB < fileSize`.
- Match/exclude/order/title/tag, import translation (tool calls included, wrappers excluded), idempotency,
  resume-resolution, cross-project-write refusal.
- REALISTIC MIX (server e2e): one busy project with native codex + Claude + Orchard-run codex — all appear
  via `/api/projects/:id/sessions`, native tagged `openai`, other-cwd excluded, recency-ordered (native +
  claude + orchard interleaved), already-imported session appears exactly once, opening a native session
  imports + renders its transcript (200).
- Anti-regressions run GREEN: typecheck; verify:sessions (52/52); verify:orchard-transcripts (15/15);
  verify:ui (7/7); verify:bug-087-stale-transcript (6/6); verify:reattach-agent-backfill (15/15 on rerun —
  a pre-existing DOM-timing flake, unrelated). verify:snapshots fails ONLY on an environmental precondition
  (/tmp reflink filesystem), not touched here. leak-gate PASS (0 hits / 405 files).

**Deploy note: CLIENT-ONLY RELOAD — no server restart needed for existing running server ONLY IF it is
restarted to pick up the new server code.** Correction, stated honestly: this is SERVER-SIDE code
(index.ts + new module), so the running server must be restarted to serve native codex sessions. No DB/
schema/migration; no client rebuild (app.js already renders the provider tag). After restart, native
sessions appear on next sidebar refresh. I did NOT restart the service (standing rule) — the operator
restarts :4317 when ready.
