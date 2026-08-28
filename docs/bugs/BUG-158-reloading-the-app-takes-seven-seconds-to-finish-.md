```orchard-ticket
{
  "id": "BUG-158",
  "type": "bug",
  "title": "Reloading the app takes seven seconds to finish filling the sidebar",
  "summary": "A reload paints an empty shell in 44 milliseconds, then shows nothing for 3.4 seconds, then fills the project list one project at a time until 7.5 seconds. Measured against the real store of 13 projects, 751 session directories and 620 external rollout files. Downloading and running the app itself accounts for 44 milliseconds of that.",
  "impact_if_we_wait": "Every reload costs about seven seconds of waiting, and the cost grows with each project added and each session recorded. Nothing is lost or wrong: the app is correct, only slow to become usable.",
  "current_need": "A build lane to stop rescanning both session stores once per project per request, and to render the shell before the project list arrives.",
  "severity": "medium",
  "area": "server session listing and app boot",
  "reported": "2026-08-27",
  "reported_by": "finding lane (measurement pass)",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-08-27",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "The project list endpoint answers in under 400 milliseconds against the real store, measured warm and repeated.",
    "Everything is in view within about one and a half seconds of a reload, measured in a browser.",
    "Each whole-store scan runs at most once per request, not once per registered project.",
    "A regression test bounds the project-list endpoint against a store of realistic size."
  ],
  "code_refs": [],
  "related": [],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": false,
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

# BUG-158 — Reloading the app takes seven seconds to finish filling the sidebar

## Symptom
The user: "the page reloads are slow, if we count until everything loads into view its several seconds."

Measured, headless browser against a scratch server holding the real registry (13 projects), the real session store (751 directories, 3,982 transcript files, 1.2 GB) and the real external-rollout store (620 files, 199 MB). Median of three loads, milliseconds from navigation start:

| at | what |
|---|---|
| 5 | HTML received (33 KB) |
| 14 | all stylesheets received (224 KB) |
| 32 | all 12 script modules received (992 KB) |
| 44 | first contentful paint — an EMPTY shell, no data |
| 37 | first API request starts |
| **3,449** | the project list returns — first real content can render |
| 3,449-7,492 | the sidebar fills in, one project at a time |
| **7,492** | last first-view data arrives; after this only 5-second polls |

**"Everything in view" is 7.5 seconds.** 7.45 of those 7.5 seconds are the server; 44 ms is the browser.

## What is NOT the problem
- **Transfer.** All 992 KB of script and 224 KB of stylesheet arrive in 32 ms over the loopback. There is no compression and every asset is sent with `cache-control: no-store`, so every reload re-downloads everything — and it still costs 32 ms. Compression would matter only if this were ever served over a network.
- **Parse and execute.** First contentful paint is at 44 ms and the browser records **zero** long tasks (main-thread blocks over 50 ms) across the whole load, including the 637 KB payload for the largest project.
- **Render and layout.** Same evidence: no long tasks, nothing measurable after the data lands.
- **The ticket board.** The board endpoint answers in 52 ms for a 256-ticket board (58 KB). Not a contributor.

## Where the time actually goes
Both of the two big costs are the same routine: `sessionsForProject()` in `src/server/index.ts`. It is called **once per registered project** on every request, and each call rescans **both entire stores from scratch, synchronously**. Nothing is cached between calls or between requests.

### 1. The project list blocks first paint for 3.4 seconds
`GET /api/projects` measured **3,272 ms warm, repeatable** (three curl runs, 21.5 KB response). A CPU profile of the running server, taken over three real requests through the inspector protocol, attributes it:

| self time per request | where |
|---|---|
| 1,128 ms | `Buffer.toString` |
| 705 ms | `readRolloutHead` (`src/server/codex-native.ts`) |
| 251 ms | `fs.readSync` |
| 221 ms | garbage collector |
| 209 ms | `utf8Slice` |
| 163 ms | `parseLine` (`src/lib/session-history.ts`) |
| 111 ms | `linesFromSample` |
| 101 ms | `probeCwd` |

Direct measurement of the two scans confirms the split:
- `listNativeCodexSessions()` walks **all 620 rollout files** and reads a 256 KB head off each one, decoding every byte to a UTF-8 string and JSON-parsing it, and only THEN filters on the working directory. One walk is 184 ms and decodes **102 MB**. It runs once per project: **13 walks, 1.33 GB of decoding, ~2.1 s.**
- `listLogicalProjects()` walks 751 directories, stats 3,982 files and reads the head of one file per directory. 84 ms per call, called once per project: **~1.0 s.**

2.1 + 1.0 = 3.1 s of the measured 3.27 s — 94% accounted for.

Because this work is synchronous, it blocks the event loop outright. Every other request queues behind it: a git-status call that answers in 33 ms on an idle server was measured at 2,531 ms during boot, and two trivial 1 KB endpoints took 723 ms each.

The client makes this worse by waiting: `boot()` in `public/app.js` awaits the project list before it renders anything at all, so the whole 3.4 s is a blank screen.

### 2. The sidebar then fills in serially for 4 more seconds
`loadAllSessions()` is `for (const p of state.projects) await loadSessions(p.id)` — thirteen requests strictly one after another. Each per-project sessions request costs ~300 ms, for the same reason: it calls the same `sessionsForProject()`, so it repeats both whole-store scans. Measured chain: 3,466 ms to 7,492 ms. That is the "content trickling in" the user described.

## What to change, and what it is worth
Estimates, labelled as such — derived from the measured per-scan costs, not from a built fix.

1. **Do each scan once per request, not once per project.** Hoist `listLogicalProjects()` and the rollout walk out of the per-project loop; index the rollout heads by working directory once and look each project up. *Estimated recovery: ~2.8 s of the 3.27 s.* A hoisted request is one rollout walk (184 ms) plus one store walk (84 ms) plus cheap per-project work — roughly 280 ms.
2. **Memoise the rollout head by file size and modification time**, exactly as `metaCache` in `src/lib/session-history.ts` already does for the session store. *Estimated: takes the remaining ~184 ms to near zero on every request after the first, and makes the per-project sessions requests cheap too.*
3. **Read a smaller head.** `HEAD_BYTES` is 256 KB, but the metadata line it is looking for is the first line of the file. 177 of the 620 files are large enough to be read in full at that budget. A 16 KB head would decode 10 MB instead of 102 MB. *Estimated: 91% less decoding per walk.*
4. **Do not block first paint on the project list.** Render the shell and the empty rail first, or drop the recency and directory-exists fields from that payload and fetch them after. The comment in the handler says recency "must never trigger the expensive operation" — but the call it makes IS the expensive operation.
5. **Fetch the per-project session lists in parallel.** Worth doing, but only after 1-3: the work is CPU-bound on a single-threaded server, so parallel requests currently just queue.

Together these are estimated to take "everything in view" from 7.5 s to roughly 1 s.

## What is irreducible
The first scan after a server start, or after the stores change, has to actually read the disk: about 84 ms for the session store and 184 ms for the rollout store, and more when the page cache is cold. A first-ever load will still cost a few hundred milliseconds of scanning. Everything above that is repeated work.

## What could not be measured
- The user's own browser. Measurements were taken with headless Brave on the same machine, which contends for CPU with the server; wall-clock numbers from the network layer were discarded in favour of in-page resource timing for that reason.
- Anything over a real network. Over the loopback, transfer is free and the missing compression costs nothing; on a network the 1.2 MB of uncompressed assets sent with `no-store` on every reload would dominate instead.
- The live service. Excluded by the brief; a scratch server on a free port was used, pointed at the real registry with its own isolated data directory so no live session host could be touched.
- A DOM-settle signal. The 5-second poll loops mutate the DOM forever, so "settles" was taken as the end of the last first-view request instead.

## Context pack
- Files in play: `src/server/index.ts` (`sessionsForProject`, the `GET /api/projects` handler, `serveStatic`), `src/server/codex-native.ts` (`listNativeCodexSessions`, `readRolloutHead`, `HEAD_BYTES`), `src/lib/session-history.ts` (`listProjectDirs`, `listLogicalProjects`, `metaCache`), `public/app.js` (`boot`, `loadAllSessions`).
- Repro test: none exists. A build lane should add one that asserts a bound on the project-list endpoint against a store of realistic size.
- Note for the fixer: measure against a realistic store. A fixture with three projects and three sessions shows none of this.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-27 — finding lane (measurement pass)
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-08-27 — fix lane (round 1)
- **Fixed** by memoising the two whole-store scans in the LEAF modules, since `sessionsForProject()` / the `/api/projects` handler live in `src/server/index.ts`, which was under active uncommitted work by two other lanes and off-limits this round. Memoisation (the ticket's fix #2) recovers what the once-per-request hoist (fix #1) would, because a process-wide cache makes the 2nd..13th per-project calls cheap.
  - `src/server/codex-native.ts` — `readRolloutHead` memoised by path+size+mtime (new `headCache` + `clearRolloutCache`); `listNativeCodexSessions` stats each rollout first and reuses the cached head. Collapses the 13 rollout walks (1.33 GB decoded/request) to one.
  - `src/lib/session-history.ts` — `probeCwd` memoised by path (`cwdProbeCache`, cleared by `clearSessionCache`); the newest-file head-read was the bulk (~120 ms) of `listProjectDirs`, re-run once per project. The stat walk (~15 ms) still runs each call, so `lastActivityAt`/`totalBytes` stay fresh.
  - `public/app.js` — `loadAllSessions` now fetches all projects' session lists in parallel (was a strict serial `for … await` chain, ~4 s of the boot); `boot()` shows a "loading projects…" row before awaiting the list.
- **Head size:** kept at 256 KB. The ticket's suggested 16 KB is UNSAFE on the real store — the `session_meta` first line embeds `base_instructions` and is ~18.6 KB (min 18392, max 19088 across all 620 rollouts), so any head < ~19 KB drops it and `listNativeCodexSessions` returns ZERO rows (the silent-wrong-answer trap). No size below 256 KB is title-identical either (128 KB loses 2 titles, 64 KB loses 5). Memoisation, not shrinking, recovers the cost.
- **Async scans:** left synchronous. The event-loop starvation is real but making the scans async requires restructuring the `/api/projects` handler in `index.ts` (off-limits this round). With the caches warm the scans now cost ~250 ms/request instead of ~3.1 s, so the starvation window shrinks ~12× even while still synchronous; converting to async is a follow-up scoped to `index.ts`.
- **Measured, real store (13 projects, 620 rollouts, 753 session dirs).** Scans (median of 3): total 3112 ms → 263 ms warm / 537 ms cold. Real HTTP `GET /api/projects`: 3272 ms (finding lane) → **270 ms warm-repeated / 1166 ms cold-first**; response byte-identical (21543 B). Both success criteria met.
- **Correctness:** `scripts/verify-bug-158-boot-perf.mjs` (`npm run verify:bug-158`) — memoised rows byte-identical to cache-cleared rows (real store); a changed file re-reads the head (never stale); a new session file still bumps `lastActivityAt`; sub-19 KB head proven to return zero. Regressions clean: verify:sessions 52/52, feat-078-native-codex 36/36 (codex store sha unchanged), feat-070-sidebar 14/14, bug-085-sidebar-cap 11/11, board:check OK. `npm run gate` exit 0.
- **Independent verify warranted:** this is a session-listing correctness change with a silent-wrong-answer failure mode (cache staleness / head-window). Recommend a clean-room pass before close.
- **index.ts NOT touched** (per constraint). Files changed: `src/server/codex-native.ts`, `src/lib/session-history.ts` (preserving the session-reorder lane's `lastUserMessageAt` hunks), `public/app.js` (boot path only), `package.json` (+`verify:bug-158`), `scripts/verify-bug-158-boot-perf.mjs` (new). Left unstaged; no git writes.
