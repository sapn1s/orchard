```orchard-ticket
{
  "id": "BUG-019",
  "type": "bug",
  "title": "Normal reloads were not serving outdated assets",
  "summary": "Static asset caching was ruled out as the cause of old behavior after a restart. Code inspection and a live browser test showed that a normal reload received current assets, so no cache-control change was made.",
  "impact_if_we_wait": "The original display behavior may still be confusing, but delaying cache changes causes no known asset-staleness harm. Bounded: this concerns display-correctness and confidence in deployed client fixes, not data loss or server state.",
  "current_need": "Keep the ticket closed: code inspection and a live normal-reload browser test ruled out stale caching, while typecheck stayed clean.",
  "severity": "high",
  "area": "Static asset delivery",
  "reported": "2026-08-04",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "done",
  "human_action": "none",
  "updated": "2026-08-04",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A normal browser reload receives and runs changed static assets without requiring a hard reload",
    "Static asset caching does not explain the reported pre-fix behavior"
  ],
  "code_refs": [
    {
      "path": "src/server/index.ts",
      "symbol": null,
      "note": "Static-file serving and response headers were inspected when testing the cache hypothesis."
    },
    {
      "path": "public/app.js",
      "symbol": null,
      "note": "The live browser test changed the served client asset and checked its behavior after a normal reload."
    },
    {
      "path": "public/styles.css",
      "symbol": null,
      "note": "Listed among the assets initially suspected of being reused after deployment."
    },
    {
      "path": "public/index.html",
      "symbol": null,
      "note": "Listed as the application shell whose asset references and caching behavior might have contributed."
    }
  ],
  "related": [
    {
      "id": "BUG-016",
      "relation": "see_also"
    },
    {
      "id": "BUG-017",
      "relation": "see_also"
    },
    {
      "id": "FEAT-018",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "exempt",
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
    "archived_path": "docs/bugs/archive/BUG-019-static-assets-not-cache-busted.md",
    "sha256": "a305d4e77e2094a196532733a9f620e4b32f196e406d00ab1538a9e5c6c2f5ac",
    "bytes": 7268,
    "original_title": "Static assets (app.js/css) served without cache-busting → browser runs STALE code after a deploy",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the supplied original; the symptom, cache hypothesis, tested assets, live-browser result, clean typecheck, rejected fix direction, and related work are preserved.",
    "dropped": []
  }
}
```

# BUG-019 — Normal reloads were not serving outdated assets

## Diagnosis

The proposed cause was stale browser reuse of `public/app.js`, `public/styles.css`, or `public/index.html` after a service restart. Inspection of `src/server/index.ts` and a live browser test disconfirmed that mechanism, so adding cache-control headers or versioned asset URLs would not address this report.

## Evidence

A real server and real browser were used to test a normal reload rather than a hard reload. The browser received and ran the changed asset, ruling out the proposed stale-cache path. `typecheck` was reported clean. `verify:ui` and `verify:asset-cache` were named, but no execution result was recorded for either suite.

## Implementation notes

No cache-control change was made. The considered approaches were revalidation with `Cache-Control: no-cache`, disabling storage with `no-store`, content-hashed asset URLs, or validators such as ETag and Last-Modified.

## Verification plan

The original plan was to change a marker or behavior in `public/app.js`, reload normally against a real server, and compare the result with a hard reload. Header inspection could additionally confirm whether revalidation occurred.

## Risks

Changing cache policy after the hypothesis was disproved could increase request traffic or disable useful caching without correcting the observed reload behavior.

## Activity log (APPEND-ONLY)
### 2026-08-04 — orchestrator
- Filed from user report (fix committed + service restarted, but reload still showed
  old behavior — classic stale-cached-JS signature). Could be the meta-cause behind
  several "still broken" reports. Dispatched to confirm + fix.

### 2026-08-04 — fix agent (BUG-019)
**Understood:** the hypothesis was "the server serves `public/*` without
cache-control, so a normal reload reuses a stale cached `app.js`." Read
`src/server/index.ts`'s `serveStatic()` (the only place `public/` is served,
around line 73) before touching anything.

**CONFIRMED header behavior — BEFORE any change (this is also the current/only
state; nothing here was edited):**
```
serveStatic() in src/server/index.ts already sets, on EVERY static response
(index.html, app.js, styles.css, lib/*.js — no per-extension branching):
  cache-control: no-store
```
Verified two ways:
1. Read the code: `res.writeHead(200, { ..., 'cache-control': 'no-store' })`
   at src/server/index.ts:84-88 — unconditional, applies to all of `public/`.
   `git log -S"no-store" -- src/server/index.ts` shows this header has been
   present since the **initial commit** (28e12b5) — it was never missing.
2. Live-checked the actual running systemd service on :4317 (read-only GET,
   did not restart/touch it):
   `curl -sD - -o /dev/null http://127.0.0.1:4317/app.js` →
   `cache-control: no-store` (same for `/`, `/styles.css`, `/lib/api.js`,
   `/lib/dom.js`). No reverse proxy sits in front (only node listens on
   4317; no nginx/etc process bound to 80/443).

`Cache-Control: no-store` forbids the browser from reusing bytes across
reloads without a fresh request — this is already the strictest possible
directive, strictly stronger than the `no-cache`/ETag fix the ticket proposed.
There is no code-level cache-busting bug to fix.

**Verification built anyway (the deliverable, since the ticket asked for a
verify script regardless of outcome):** `scripts/verify-asset-cache.mjs`
(+ `npm run verify:asset-cache`). Real server on a scratch free port (no
9317/4317 involved) + real headless Brave via CDP:
  1. HTTP layer — fetches `/`, `/app.js`, `/styles.css`, `/lib/api.js`,
     `/lib/dom.js` and asserts each `Cache-Control` forces revalidation
     (no-store or no-cache/must-revalidate).
  2. Browser layer — loads the page, appends a `window.__BUG019_MARKER__ = …`
     line to `public/app.js` **on disk** (simulating "a fix just shipped"),
     does a plain `location.reload()` (NOT a cache-bypassing hard reload),
     and asserts the marker is now present (new code ran). Restores
     `public/app.js` to its original bytes in a `finally`, even on throw.

**Verified (ran against current/unmodified code — no fix was applied, since
none was needed):**
```
npm run verify:asset-cache
  PASS  / Cache-Control forces revalidation on every load           (no-store)
  PASS  /app.js Cache-Control forces revalidation on every load      (no-store)
  PASS  /styles.css Cache-Control forces revalidation on every load  (no-store)
  PASS  /lib/api.js Cache-Control forces revalidation on every load  (no-store)
  PASS  /lib/dom.js Cache-Control forces revalidation on every load  (no-store)
  PASS  marker absent before the on-disk edit
  PASS  a NORMAL reload picks up the on-disk app.js change (not stale-cached)
  7 passed, 0 failed

npm run typecheck    → clean (no output, no errors)
npm run verify:ui -- --offline → UI: 3 passed, 0 failed (OFFLINE — live turn skipped)
```
Per the ticket's own acceptance bar ("must FAIL on current code" if the bug is
real) — it does not fail. That absence-of-failure IS the finding: this specific
mechanism (missing/weak Cache-Control on `public/*`) is not, and was never,
broken.

**Still open / handoff:** the underlying user-visible symptom — "restarted
after a client fix landed, normal reload still showed old behavior" — is
presumably real and needs a different lead, since this ticket's mechanism is
ruled out. Candidates worth checking next, roughly in order of likelihood:
1. **The service wasn't actually restarted / the new file wasn't actually on
   disk yet** when the user reloaded (deploy-timing race, not caching) — check
   the restart script/flow, not the server.
2. **The browser tab never navigated** — if any user action was interpreted
   as SPA-style state refresh (e.g. clicking something that re-fetches
   `/api/*` without `location.reload()`), the already-loaded `app.js` module
   instance keeps running old code in memory; no HTTP request happens at all,
   so no header would help. Worth checking whether the dashboard has any
   soft-refresh path that a user might mistake for "reload."
3. A stale **browser tab that was never actually reloaded** (human just didn't
   press reload) — mundane but should be ruled out before chasing more code.
No code changed by this pass (`src/server/index.ts` untouched); only
`scripts/verify-asset-cache.mjs` and the `verify:asset-cache` npm script were
added, plus this ticket. Not committed, per the hard rules.
