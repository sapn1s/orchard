```orchard-ticket
{
  "id": "BUG-252",
  "type": "bug",
  "title": "Reloading a new container session says the session is not here",
  "summary": "After reloading the tab of a just-created container session, the page says \"This link points to a session that is not here\" and drops to the bare project, although the session exists and opens from a correct link.",
  "impact_if_we_wait": "Every reload of a freshly started container session loses the view of the session the user was watching, and shows a message that it was deleted.",
  "current_need": "Independent design review of the deferred re-resolve (two-break). The session-init dir and resolver half holds.",
  "severity": "medium",
  "area": "client deep-link resolution",
  "reported": "2026-10-12",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "blocked",
  "human_action": "none",
  "updated": "2026-10-12",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "After a reload, a link to a live session with no transcript yet renders that session, not the not-here notice.",
    "After a reload, a link to a session with a partial transcript renders it.",
    "A link with a stale dir to an existing session renders it and the URL is corrected to the real dir.",
    "A link to a bogus id still says \"not here\", and resolves on its own once a session with that id appears.",
    "A new container session's URL carries the container store dir from its first session-init."
  ],
  "code_refs": [
    {
      "path": "public/app.js",
      "symbol": "applyRoute",
      "note": "history-only, exact-dir match; empty → permanent \"not here\""
    },
    {
      "path": "public/app.js",
      "symbol": "onEvent case 'session-init'",
      "note": "encodedDir fallback to the project host dir — wrong for container sessions"
    },
    {
      "path": "src/server/agent-bridge.ts",
      "symbol": "storeEncodedDir",
      "note": "the owner of where a live session's transcript lands"
    }
  ],
  "related": [
    {
      "id": "FEAT-155",
      "relation": "see_also",
      "note": "container store dir is declared by container-manager, not re-encoded from cwd"
    },
    {
      "id": "BUG-195",
      "relation": "see_also",
      "note": "session-init refetches the nav list; same handler"
    }
  ],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "anthropic",
      "model": "opus",
      "run_id": "c01b61e7-6129-4303-955f-187bd356415c",
      "verdict": "broken",
      "verdict_on": "2026-10-12",
      "recorded_at": "2026-10-12T09:38:39.352Z",
      "author": "fixing lane (agent)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "composer start on the not-here view is hijacked by the deferred re-resolve (start bypasses routeGen; routeRetryCurrent ignores a pending start)"
    },
    {
      "provider": "anthropic",
      "model": "opus",
      "run_id": "d215bd11-762a-4e30-93e0-860d1350afdf",
      "verdict": "broken",
      "verdict_on": "2026-10-12",
      "recorded_at": "2026-10-12T09:55:46.571Z",
      "author": "fixing lane (agent)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "two-break: a scroll-driven syncUrl rewrites the starting-view hash, so the deferred re-resolve disarms itself and a live session's link stays dead"
    }
  ],
  "verification_class": "plan+review",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": false,
    "Implementation notes": false,
    "Verification plan": false,
    "Migration and rollback": false,
    "Risks": false,
    "Activity log": true
  },
  "source": {
    "archived_path": null,
    "sha256": null,
    "original_title": null,
    "migrated_on": null,
    "migrated_by": null,
    "confirmation": "Authored directly in the record format through scripts/board-tool.mjs. There is no legacy original.",
    "dropped": []
  }
}
```

# BUG-252 — Reloading a new container session says the session is not here

## Symptom
"This link points to a session that is not here. No session 5b2f90a7… under '<project>'. It may have been deleted, or the link may be wrong." — shown after reloading the tab of a container session the user had just created and was watching work. The same session opens fine from a correct link minutes later.

## Repro
1. In a project with isolation "container", start a new session and send the first message.
2. Once the session has started (URL gains /session/<id>), reload the tab.
3. The page shows "This link points to a session that is not here" and drops the URL to the bare project.

Real instance (user's Brave history, read-only copy): the reload at 2026-10-12 10:57:40 loaded `#/project/<project>/session/5b2f90a7-…?dir=-home-<user>-projects-<project>`. The transcript lives in `~/.claude/projects/-workspace-<project>/` (created 10:57:29.27, so it was already on disk at reload). The `?dir=-workspace-<project>` URL in the report was visited later, at 11:00:44, and resolves.

## Expected
A link to a session that exists — on disk, or live in this server's bridge before its transcript is listed — opens that session. A link whose `dir=` is stale but whose id names exactly one session opens it and corrects the URL. A link to an id that exists nowhere still says "not here", and resolves on its own if that session appears later.

## Diagnosis
Two faults, one user symptom:
1. **Wrong dir written into the URL (root cause).** The session-init handler in public/app.js sets the new session's `state.current.encodedDir` from the project list's `encodedDir`. That is the encoded HOST path (`-home-<user>-projects-<project>`). A container session's transcript lives in the container store dir (`-workspace-<id>`; FEAT-155, `AgentSession.storeEncodedDir`, owned by container-manager). The URL, and every key derived from it, names a directory the session is not in.
2. **The resolver dead-ends.** `applyRoute` matches the link only against the on-disk history list, and only with the exact `dir`. A stale dir, or a live session not listed yet, renders "not here" for good. It never asks the live registry and never retries.

Refuted hypothesis: "the reload landed before the transcript was listed". The file existed 11 s before the reload, and the server's listing reads the filesystem live (no stale cache in this path).

## Context pack (grows — the "where to look", so no agent cold-starts)
- Files/functions in play: public/app.js `applyRoute` and the `session-init` case in `onEvent`; src/server/agent-bridge.ts `storeEncodedDir` (getter, FEAT-155); src/server/index.ts `GET /api/sessions` and `sessionsForProject`.
- Related tickets: FEAT-155 (container store dir is declared, not re-encoded); BUG-195 (session-init refetch of the nav list); BUG-198 (overrides keyed by encodedDir+sessionId).
- Repro test: scripts/verify-bug-252-deeplink-live-session.mjs
- Known dependencies / blockers: a concurrent lane edits the session-start / outbox path of agent-bridge.ts, index.ts start handler and outbox.ts.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-12 — user
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-12 — fixing lane (agent)
- **fixing r1:** **Understood:** Hypothesis "the reload landed before the transcript was listed" is REFUTED for the real incident. Evidence: (1) the transcript `~/.claude/projects/-workspace-<project>/5b2f90a7….jsonl` has birth time 10:57:29.27 local; (2) the service log shows the tab's socket closing at 10:57:40 (the reload); (3) the user's Brave history (read-only copy) records the reload URL at 10:57:40 as `…/session/5b2f90a7-…?dir=-home-<user>-projects-<project>`. The `?dir=-workspace-<project>` URL in the report was first visited at 11:00:44. The server listing reads the filesystem live; the container dir was listed. ROOT CAUSE: the `session-init` handler in public/app.js filled a new session's `state.current.encodedDir` from the project list's `encodedDir`, which is the encoded HOST path. A container session's transcript lands in `-workspace-<id>`, which the bridge declares as `storeEncodedDir` (FEAT-155). `applyRoute` then matched id+dir exactly against the history list only, and rendered a permanent "not here". The same fallback also gave a cross-project fork its SOURCE dir: `armFork` keeps it on purpose, so the frame must override it when the identity changes.
  **Plan review (cross-provider):** `dispatch-client --provider openai`, transcript `~/.local/share/claude-station/transcripts/openai/-home-<user>-projects-orchard/01a12f33-db0d-7221-90bc-7e3f95b7617c.jsonl`, verdict SOUND-WITH-CHANGES. The five findings were all adopted: (1) a fork keeps its source dir, so adopt the declared dir whenever the identity changes, not only when the dir is null; (2) the server dedupes one copy per id, so honour the link's own dir when that file is really there; (3) navigation-generation invalidation across awaits, overlays and popstate; (4) retry on its own timer and on visibility, independent of the 30 s live window; (5) a list-fetch failure is not "absence".
  **Changed (unstaged, no git writes):** src/server/agent-bridge.ts (session-init carries `encodedDir: this.storeEncodedDir`; one field in the system:init handler, not the start/outbox path); src/server/events.ts (type); src/server/index.ts (GET /api/sessions rows add read-only `storeEncodedDir`; not the start handler); public/lib/api.js (`liveBridges` keeps `projectId` + `storeEncodedDir`); public/app.js (session-init adopts the declared dir on a new identity; `applyRoute` → one chokepoint `resolveRouteSession`: history exact → unique id with a stale dir (honouring the link's dir if its file exists) → live bridge (`starting` view, never "not here") → `unknown` on fetch failure → `missing`; `renderUnresolvedRoute`; `armRouteRetry` with backoff 1 s to 60 s for 15 min, nudged by `refreshLive` and visibilitychange; `nav.routeGen` bumped by applyRoute/openSession/startNew; URL corrected only over the link or the bare-project hash); scripts/verify-bug-252-deeplink-live-session.mjs (new).
  **Verified:** `node scripts/verify-bug-252-deeplink-live-session.mjs` → FIXED 12/12 PASS; synthesized PRE-FIX (original applyRoute spliced in, dir adoption removed, served to the page by interception) 8/12 FAIL, exactly the must-fail set A1 A2 B1 B2 E F G I. Pre-fix A1 reproduces the incident's URL shape (`dir=<encoded host path>`), and A2 shows "not here" on reload. Real browser (headless Brave), real server, real bridge, scripted fake `claude` reporting cwd `/workspace/b252proj`. This is a synthetic container stand-in, because the host Docker daemon is off-limits. Scenarios: new session through the real composer + reload; live with no transcript; partial (truncated) transcript; bogus id; stale dir; wrong dir + bogus id; appears later; list fetch 500s; navigate away (sidebar click) then the id appears; duplicate id folded by the server. `npm run gate` → PASS (exit 0). Anti-regression: verify-bug-195 6/6, verify-bug-094 10/10. verify-bug-198 fails X2 and X3 (23/25) and verify-bug-196 fails (j) (59/60). All three fail IDENTICALLY on a scratch copy of the working tree with both BUG-252 client changes reverted, so they predate this change (other in-flight lanes).
  **Side finding (not fixed, out of scope):** when the server's memory-unify step (BUG-215) emits a NON-fatal `error` before a start's ack (here ENOENT because the host store dir did not exist), the client's pre-ack refusal branch (`state.pendingStart != null` → `rollBackPendingStart`) treats it as a refused start and closes the socket, so the session never shows. The verify script pre-creates both store dirs to avoid it. Worth its own ticket.
  **Still open / handoff:** a real container session (Docker) was not exercised. The reattach `session-init` in index.ts (start handler, another lane's region) still carries no `encodedDir`; the client keeps its opened dir there, which is correct. Independent clean-room verify running (cross-provider).

### 2026-10-12 — fixing lane (agent)
- **Verification recorded:** dispatch anthropic/opus run c01b61e7-6129-4303-955f-187bd356415c — VERDICT: BROKEN — composer start on the not-here view is hijacked by the deferred re-resolve (start bypasses routeGen; routeRetryCurrent ignores a pending start). Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-12 — fixing lane (agent)
- **Verification recorded:** dispatch anthropic/opus run d215bd11-762a-4e30-93e0-860d1350afdf — VERDICT: BROKEN — two-break: a scroll-driven syncUrl rewrites the starting-view hash, so the deferred re-resolve disarms itself and a live session's link stays dead. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-12 — fixing lane (agent)
- **fixing r1 — two-break:** **Round 2 (fix for IV run c01b61e7, BROKEN):** that run (anthropic/opus; OpenAI dispatch hit its quota window) found that a composer start on the "not here" view was hijacked by the deferred re-resolve. Fixed: `startTurn` bumps `nav.routeGen` and disarms the retry; `routeRetryCurrent` also requires no pending start and no live bridge; `retryRoute` skips a tick while the composer holds text. The verify script gained J (composer start, with the fake holding system:init), K (typed draft) and M (#/tickets overlay), plus a synthesized ROUND-1 client on which J and K must FAIL. `node scripts/verify-bug-252-deeplink-live-session.mjs` → FIXED 15/15 PASS; PRE-FIX 8/15 FAIL (A1 A2 B1 B2 E F G I); ROUND-1 2/2 FAIL (J K). `npm run gate` → PASS (exit 0).
  **IV run d215bd11 (anthropic/opus) → BROKEN, second path.** Open a long, scrolled session, then follow a link to a live session with no transcript. The "starting" view leaves the link hash in place, and the pane reset fires a scroll. ~400 ms later `onScroll → syncUrlSoon → syncUrl` rewrites the hash to `#/project/<p>`. `routeRetryCurrent` requires `location.hash === t.hash`, so every later retry and nudge disarms itself and the session never opens: a dead link again, with no user action. The "unknown" (list failed) view keeps the hash the same way and is likely hit too (not run).
  **TWO-BREAK STOP (WA): route to independent design review.** The deferred re-resolve broke the "resolves later, never hijacks" half of the property twice, by different paths: (1) a navigation that did not bump `nav.routeGen` hijacked the view; (2) an incidental URL sync defeated the "still the unresolved view" proxy and killed the retry. One cause for both: "is this still the unresolved view?" is INFERRED from proxies (hash equality, a generation counter every navigation must remember to bump, pendingStart, composer text) instead of being a state that one place owns. Not patched further.
  **What holds (both IV runs re-ran the fixer's suite green; neither break touched it):** the session-init dir now comes from the bridge (`storeEncodedDir`), and the resolver chokepoint handles a stale dir, a duplicate copy, a live-but-unlisted session ("starting") and a list-fetch failure, none of which shows "not here". These fix the user's actual incident (the reload of a new container session).
  **Design options for the review:** (a) make the unresolved view an owned state: `renderUnresolvedRoute` sets `state.current.unresolved = route`; every reassignment of `state.current` clears it by construction; `currentRoute()`/`syncUrl` render it, so the URL cannot drift; the retry checks that object's identity and no proxies. (b) Drop the automatic re-resolve and keep only the "starting" view, with an explicit "Open when ready" or "Check again" control (no hijack possible, slightly worse UX). (c) Ship the deterministic half now (session-init dir + resolver, no retry) and file the late-appearance behaviour separately.
  **Untested:** real Docker container session; Back/Forward into an unresolved view; phone layout; the 15-min retry cap; the Settings drawer open over the view.
