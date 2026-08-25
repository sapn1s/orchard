# BUG-019 — Static assets (app.js/css) served without cache-busting → browser runs STALE code after a deploy

- **Status:** DONE — NOT-A-BUG (cache ruled out; disconfirmed by code + live real-browser test)
- **Severity:** high (systemic — makes client-side fixes appear "still broken" after they ship)
- **Area:** server / static asset serving / deploy
- **Reported:** 2026-08-04 by user (still saw pre-fix reload behavior after a restart)

## Symptom / hypothesis
After committing `public/app.js` fixes (BUG-016 rail refresh, BUG-017 reload
summary, FEAT-018 rail…) and restarting the service, the user still sees the OLD
behavior on a normal page reload. Leading hypothesis: the server serves
`app.js`/`styles.css`/`index.html` without cache-control, so the browser reuses a
cached (pre-fix) `app.js` until a HARD reload (Ctrl+Shift+R). If true, this has
silently masked multiple client-side fixes this session — a fix ships, but never
reaches the user's tab.

## Repro (to confirm)
Load the dashboard, modify `public/app.js` (or bump a marker), restart/keep the
service, do a NORMAL reload → does the browser fetch the new asset or a 200-from-
cache / 304 stale copy? Compare with Ctrl+Shift+R.

## Fix direction
Serve the app's HTML/JS/CSS with `Cache-Control: no-cache` (revalidate every load)
or `no-store`, OR content-hash/versioned asset URLs, OR proper ETag/Last-Modified
so a normal reload always runs current code. Check how `src/server/index.ts` serves
`public/*` and what headers it sets. Simplest robust option: no-cache on the app
shell + assets. (Long-cache only truly-immutable versioned files.)

## Verification (REQUIRED)
Real browser + real server on a scratch port: load the page, change app.js on disk,
do a NORMAL reload (not hard), assert the browser now runs the NEW code (e.g. a
marker/behavior change appears); and/or assert the served asset carries no-cache /
revalidation headers. Must FAIL on current code (stale served). verify:ui offline + typecheck.

## Context pack
- Suspect: `src/server/index.ts` static-file serving + headers; maybe `public/index.html`
  asset refs. Server-side (no app.js logic change needed for the header fix).

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
