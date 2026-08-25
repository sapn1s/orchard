# FEAT-078 — detect & list native (external) codex sessions for a project, like Claude sessions

- **Status:** RESOLVED (2026-08-14, worker) — native codex sessions detected + listed + viewable + resumable
- **Area:** src/lib/session-history.ts / src/server/orchard-transcripts.ts (provider session listing) + the project session sidebar
- **Reported:** 2026-08-14 by user ("do we show codex sessions same as claude when adding a project? if not, implement")

## Current state (traced)
- **Codex sessions RUN through Orchard** are fully supported: recorded under Orchard's own
  `transcripts/openai` provider root and badged live in the sidebar like Claude (watcher.ts:334,
  `providerRoots()` in orchard-transcripts.ts).
- **GAP:** pre-existing codex sessions made with the NATIVE `codex` CLI are NOT detected. Orchard reads
  Claude's *native* store (`~/.claude/projects/<encodedCwd>/*.jsonl`) so Claude history auto-appears on
  add-project — but for codex it reads only its own mirror, never codex's native store. So external
  codex work is invisible.

## Codex native store (confirmed on disk)
- Layout: `~/.codex/sessions/YYYY/MM/DD/rollout-<ISOts>-<session_id>.jsonl` — keyed by DATE, not cwd
  (unlike Claude's cwd-encoded dirs). Also `~/.codex/history.jsonl`. Store dir overridable by
  `CODEX_HOME` (codex-runtime.ts:170 already reads it).
- First line is `{"type":"session_meta","payload":{ session_id, id, timestamp, cwd, model_provider:"openai", cli_version, ... }}`.
  The project association is `payload.cwd`; the session id is `payload.session_id`. Subsequent lines are
  rollout events (`event_msg`, etc.) — a different schema from Claude's jsonl.

## Wanted
1. **Detect + list** a project's native codex sessions alongside Claude ones: scan `~/.codex/sessions`
   (respect `CODEX_HOME`), read each file's `session_meta.cwd`, match to the project's hostPath, and
   surface id/title/last-activity in the same sidebar list (tagged as OpenAI/codex, consistent with the
   existing codex badging). Efficiency: the date-tree can be large — scan newest-first / bounded, and
   read only the `session_meta` head line per file, not the whole rollout.
2. **Title/metadata**: derive a human title from the rollout (first user message or a summary) matching
   how Claude sessions get titles.
3. **Resume/fork**: determine feasibility — codex-runtime already runs codex; can a native session id be
   resumed/forked through it? If yes, wire it; if it's a larger lift (format/id mapping), implement
   read-only listing now and file the resume half as a follow-up, stating which.

## Verification (§C)
- Synthetic `~/.codex/sessions`-shaped fixture (via `CODEX_HOME` to a scratch dir): rollout files under a
  date tree with `session_meta.cwd` = a fixture project hostPath and some for OTHER cwds. Assert the
  project's sessions are listed, other-cwd sessions excluded, title derived, and only the head line is
  read (no full-file parse). Must-FAIL pre-fix: a project with only native codex sessions shows none.
- Realistic-state: mix native codex + Claude + Orchard-run codex sessions for one project → all appear,
  correctly tagged, ordered by recency.
- Anti-regressions: verify:sessions, existing history/transcript suites, verify:ui, typecheck, leak-gate.
  Keep real home paths out of tests (CODEX_HOME scratch + os.homedir()).
- **Risk bucket:** read-only history listing (low) unless resume is wired (then session-lifecycle → flag
  independent verify for the resume path).

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
