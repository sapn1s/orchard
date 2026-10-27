#!/usr/bin/env node
/**
 * verify-feat-201-duration-grant.mjs — FEAT-201 (grant git writes for a
 * user-chosen duration such as 24 hours).
 *
 * WHAT CHANGED: the server ceiling MAX_GRANT_MS was 6h, so a timed grant for
 * 8h/24h was SILENTLY clamped to 6h. FEAT-201 raises it to 24h and the Git-tab
 * Manage panel now offers 30m/1h/8h/24h/custom (the custom field is UI-capped at
 * 1440 min so a chosen value is never silently clamped). "Until I turn it off"
 * (the standing/permanent grant) already serves "until revoked".
 *
 * WHAT THIS GRADES, against the REAL store (scripts/lib/git-grant-store.mjs) —
 * the exact module the POST route mutates and the runtime's authorisation path
 * (claimGrant/useClaim) reads:
 *   1. NON-VACUITY — MAX_GRANT_MS must be 24h. On the pre-FEAT-201 tree it was
 *      6h, so assertions (2)/(3) FAIL there (must-FAIL-before baseline).
 *   2. A user-chosen duration (1h, 8h, 24h, custom 90m) stores an expiry exactly
 *      that far out — no silent clamp within the ceiling.
 *   3. The ceiling still bites: a >24h request (48h) clamps to exactly 24h, so a
 *      timed pass can never linger indefinitely (invariant preserved).
 *   4. EXPIRY IS ENFORCED, not just displayed: the runtime authorisation path
 *      authorises a write inside the window and refuses one past the expiry.
 *   5. The agent-cannot-mint/extend invariant is structural (requireUserCaller on
 *      the POST route) and UNCHANGED by this feature — proven end-to-end by
 *      scripts/verify-feat-164-self-grant.mjs, run as the anti-regression (not
 *      duplicated here; see this ticket's Activity log).
 *
 * The route's own arithmetic (minutes → ttlMs = minutes*60000) is mirrored here so
 * the test exercises what the UI actually sends.
 *
 *   node scripts/verify-feat-201-duration-grant.mjs
 */
import {
  grantGitWrite, grantView, timedGrantView, claimGrant, useClaim, revokeGitWrite,
  MAX_GRANT_MS, _resetGitGrantsForTest,
} from './lib/git-grant-store.mjs';

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${name}`); return; }
  fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
};

const MIN = 60_000, HOUR = 60 * MIN;
/** The grant POST route's arithmetic: scope 'duration', minutes N → ttlMs. */
const ttlFromMinutes = (n) => Math.round(n * 60_000);

// ── 1. NON-VACUITY ──────────────────────────────────────────────────────────
ok('MAX_GRANT_MS is 24h (was 6h pre-FEAT-201)', MAX_GRANT_MS === 24 * HOUR,
  `got ${MAX_GRANT_MS} ms (${MAX_GRANT_MS / HOUR}h)`);

// ── 2. A chosen duration stores exactly that expiry (no silent clamp ≤ 24h) ───
for (const minutes of [30, 60, 480, 1440, 90]) {
  _resetGitGrantsForTest();
  const T = 1_700_000_000_000;
  const key = `proj-${minutes}`;
  const v = grantGitWrite(key, { scope: 'duration', ttlMs: ttlFromMinutes(minutes), now: T });
  const expectMs = minutes * MIN;
  ok(`${minutes} min grant → expiry ${minutes} min out`,
    v.scope === 'duration' && v.expiresInMs === expectMs && Date.parse(v.expiresAt) === T + expectMs,
    `scope=${v.scope} expiresInMs=${v.expiresInMs} want ${expectMs}`);
}

// ── 3. The 24h ceiling still bites: >24h clamps to exactly 24h ────────────────
{
  _resetGitGrantsForTest();
  const T = 1_700_000_000_000;
  const v = grantGitWrite('proj-huge', { scope: 'duration', ttlMs: ttlFromMinutes(48 * 60), now: T });
  ok('48h request clamps to exactly 24h (ceiling preserved)',
    v.expiresInMs === 24 * HOUR && Date.parse(v.expiresAt) === T + 24 * HOUR,
    `expiresInMs=${v.expiresInMs} want ${24 * HOUR}`);
}

// ── 4. Expiry is ENFORCED on the authorisation path, not just displayed ───────
{
  _resetGitGrantsForTest();
  const T = 1_700_000_000_000;
  const key = 'proj-enforce';
  grantGitWrite(key, { scope: 'duration', ttlMs: ttlFromMinutes(24 * 60), now: T });

  // Inside the window (23h in): a fresh claim authorises a write.
  const at23h = T + 23 * HOUR;
  const c1 = claimGrant(key, at23h);
  ok('within the 24h window a write is authorised', !!c1 && useClaim(c1, at23h) === true);

  // The display read still shows time left inside the window.
  const tv = timedGrantView(key, at23h);
  ok('remaining time is shown inside the window', !!tv && tv.expiresInMs === 1 * HOUR,
    `expiresInMs=${tv && tv.expiresInMs}`);

  // 1 ms past expiry: no claim can be minted → no write authorised.
  const past = T + 24 * HOUR + 1;
  const c2 = claimGrant(key, past);
  ok('past expiry no write is authorised (grant purged)', c2 === null);
  ok('past expiry the display read is empty too', grantView(key, past) === null);
}

// ── 5. Early revoke still works for a long grant ──────────────────────────────
{
  _resetGitGrantsForTest();
  const T = 1_700_000_000_000;
  const key = 'proj-revoke';
  grantGitWrite(key, { scope: 'duration', ttlMs: ttlFromMinutes(24 * 60), now: T });
  ok('a 24h grant is live before revoke', !!grantView(key, T + HOUR));
  const hadTimed = revokeGitWrite(key);
  ok('revoke reports it removed the timed grant', hadTimed === true);
  ok('after early revoke the grant is gone', grantView(key, T + HOUR) === null);
  ok('after revoke no write is authorised', claimGrant(key, T + HOUR) === null);
}

console.log(`\nFEAT-201 duration grant: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILURES:\n' + failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
process.exit(0);
