# BUG-070 — outcomes rail: no dates (old entries read as today), no way to clear; stale swarms linger forever

- **Status:** VERIFIED 2026-08-13 (deployed) — self-verified 2026-08-12 (verify:bug-070 22/22, pre-fix 11/22; commit 660fd87); deployed 2026-08-13, pid 1162138 runs the latest code. Reconciled FIXED→VERIFIED and the stale 👤 owner cleared (the fix is done, no user question is pending). Independent-verification dispatch remains advisory-outstanding (FEAT-061 WARN), not blocking.
- **Area:** UI outcomes/deaths rail (FEAT-057 surface) + outcomes.ts retention/dismiss
- **Reported:** 2026-08-12 by user:
  > "50 agents stopped — rate-limited … these errors were idk like 1-2 days ago and still will
  > show always as if 7pm today. this section needs ability to clear data somehow and/or show dates"

## Symptoms
1. Entries render time-of-day only ("7:08:50 PM") — an entry from any previous day is
   indistinguishable from today's. (The ISO timestamp exists in the record; the renderer drops
   the date.)
2. No dismiss-all / clear affordance: per-entry dismiss exists (`dismissedAt`), but a mass event
   (yesterday's session-limit cut = ~50 entries at once) must be dismissed one by one, so nobody
   does, so the rail is permanently full of fossils and real new deaths drown.
3. No retention policy: outcomes accumulate unbounded.

## Wanted
1. **Dates:** relative day labeling ("today 19:08", "yesterday 19:08", "Aug 10 19:08") or
   equivalent — a reader must never mistake an old entry for a fresh one. Cluster headers
   (BUG-041's one-host-event grouping) carry the date too.
2. **Clear:** a "dismiss all" on the section header (and per-cluster dismiss for grouped events);
   server-side bulk dismiss endpoint (sets dismissedAt on matching records; ledger stays
   append-only on disk — dismissal is display-state, not deletion; the record's evidentiary value
   per ARCH-002 is preserved).
3. **Retention/cap in the rail:** default view shows only recent/undismissed (e.g. last 48h or
   last N), with an explicit "show all" — the ledger file itself is not truncated by this ticket.
4. Briefings ("while you were away") unaffected — they already scope to "since your last turn".

## Verification (§C)
Fixture ledger with entries today/yesterday/3 days ago + a 50-entry same-cluster swarm →
rail shows dated labels (must FAIL pre-fix: all render as bare times), dismiss-all clears the
view and persists across reload (dismissedAt set server-side), cluster dismiss works, "show all"
reveals dismissed/old, on-disk ledger line count unchanged by dismissals. Anti-regressions:
verify:agent-outcomes 45/45, verify:rail-refresh, verify:ui, typecheck.

## Activity log (APPEND-ONLY)
### 2026-08-12 — orchestrator
- Filed from the user's report; the 50-entry swarm is yesterday's Anthropic session-limit cut
  (real event, correctly recorded — the failure is presentation lifecycle, not the recording).

### 2026-08-12 — fix agent (in-place, lane: outcomes.ts + rail) — FIXED & VERIFIED

The failure was purely PRESENTATION LIFECYCLE, exactly as filed — the ledger records the ISO
timestamp, the cluster id, and `dismissedAt` already (FEAT-057 + BUG-041). Nothing about how a
death is RECORDED changed; this fix is about how the rail READS the record. The ledger stays
append-only on disk — every dismissal only flips `dismissedAt` in place, so record + line count are
provably unchanged (§C).

**Wanted 1 — dated labels.** `outcomes.dayLabel(atMs, now)` (server) + a verbatim client mirror:
"today" / "yesterday" / "Aug 10", on CALENDAR-day boundaries (not a rolling 24h — a "yesterday
23:00" reads as yesterday an hour later, which is the reported "as if 7pm today" case). Every rail
row and every cluster header is now `who · cause · <day> HH:MM`. The briefing's `outcomeLine`
(ISO-stamped) was deliberately NOT touched.

**Wanted 2 — clear.** No new endpoint was needed: `POST /api/agent-outcomes/dismiss` already takes
`{ids}` or `{all:true}` and only sets `dismissedAt` (FEAT-057). The rail now spends it: a
**dismiss-all** on the section header (dismisses every displayed id) and a **per-cluster dismiss**
on each grouped host-level event (BUG-041 cluster) — so yesterday's 50-agent cut clears in ONE
click, not fifty. Both persist across reload (server write). The 50-swarm renders as one dated
"50 ended together" header, not fifty rows.

**Wanted 3 — recent cap + show all.** The rail's default view is recent (≤48h) + undismissed; a
"show all (+N)" toggle reveals older-than-48h and dismissed records. Windowing is CLIENT-side over
the full bounded set (`all=1&limit=200`), so "show all" flips instantly and stays reachable; the
ledger file is never truncated. (I first drafted a server-side `sinceMs` window but dropped it —
client-side windowing kept "show all" reachable without a refetch and avoided a second filter path.)

**Wanted 4 — briefings untouched.** `takeBriefing` / `outcomeLine` / clustering unchanged;
`verify:agent-outcomes` 45/45 re-proves the briefing end-to-end.

**Files:** `src/server/outcomes.ts` (`dayLabel`), `public/app.js` (rail render: dates, cluster
grouping, dismiss-all + per-cluster dismiss, show-all/recent), `public/lib/api.js` (`all` param),
`public/styles.css` (`.lnk` / cluster sub-rows — the dismiss control had NO styling before, it
rendered as a raw `<button>`). `src/server/index.ts` route unchanged (already supported the
capability). New: `scripts/verify-bug-070-outcomes-rail.mjs`, `package.json` `verify:bug-070`.

**Verification — `verify:bug-070`: 22/22 post-fix; PRE-FIX (clean HEAD worktree) 11/22.** The 11
pre-fix FAILs are the load-bearing ones and observe the bug verbatim: rows render as bare
`7:30:06 AM` (no day word), the 50-swarm is fifty separate rows with no grouped dismiss, "show all"
does not exist, and "dismiss all" leaves recent deaths on reload. Fixture ledger = today / yesterday
/ 3-days-ago + a 50-record same-cluster swarm; asserts dated labels, per-cluster dismiss (50→0 in
one click, 50 `dismissedAt` on disk), dismiss-all persists across reload, "show all" reveals the
3-days-ago death, and — the ARCH-002 invariant — on-disk line count (1206) and record count (53)
UNCHANGED by every dismissal (52 dismissed, the old one retained undismissed). Part A unit-proves
`dayLabel` + the display-state-not-deletion property directly against the module.

**Anti-regressions:** `verify:agent-outcomes` **45/45** (its rail assertions pass over the new
dated cluster rendering), `verify:ui` 7/7, `typecheck` PASS, leak-gate PASS.
`verify:rail-refresh` FATAL-errors — but it does so **identically on clean HEAD** (a `#railNeeds`
needs-card `textarea.nc-input` is null, a different rail than this lane); PRE-EXISTING, not caused
here.

**DEPLOY REQUIRED (not done):** `outcomes.ts` and the client bundle changed; the running
`claude-station` service still serves the old rail until a later deploy. Verified only against a
scratch server on a free port. No push, no deploy performed.

### 2026-08-13 — board reconciliation
- Deploy has since happened (commit 660fd87 live; pid 1162138 runs the latest code). Two problems this
  ticket was causing on the FEAT-067 rail summary: (1) it carried a stale 👤 owner — cleared, since
  the fix is done and no user question/decision is pending (this was inflating needs-you); (2) its
  header said FIXED (not a Done token) so board:gen kept it in Open (inflating queued). Relabeled
  FIXED→VERIFIED. Independent verification remains advisory-outstanding only (WARN, non-gating).
