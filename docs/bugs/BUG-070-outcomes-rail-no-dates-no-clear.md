```orchard-ticket
{
  "id": "BUG-070",
  "type": "bug",
  "title": "Old outcomes appeared current and crowded out new events",
  "summary": "The outcomes rail now distinguishes dates, supports bulk and grouped dismissal, and limits its default view while preserving the ledger. The pre-fix cases failed, then the corrected behavior and related outcome and interface checks passed.",
  "impact_if_we_wait": "Before deployment, stale events looked current and crowded out new failures. Bounded: this affected display correctness and usability, not ledger integrity, stored evidence, briefings, or user data.",
  "current_need": "Treat the ticket as closed: the pre-fix cases failed, the corrected behavior passed, and standing checks stayed clean.",
  "severity": "medium",
  "area": "Outcomes rail",
  "reported": "2026-08-12",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-13",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Old outcomes display dates that distinguish them from events recorded today",
    "Bulk dismissal clears visible outcomes and persists across reload",
    "Grouped outcomes can be dismissed together",
    "The default view limits stale outcomes while show all reveals them",
    "Dismissal leaves the append-only ledger line count unchanged",
    "Briefings continue using their existing last-turn scope"
  ],
  "code_refs": [
    {
      "path": "outcomes.ts",
      "symbol": "dismissedAt",
      "note": "Bulk dismissal records display state without deleting ledger entries."
    }
  ],
  "related": [
    {
      "id": "FEAT-061",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": true,
    "Verification plan": true,
    "Migration and rollback": true,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/BUG-070-outcomes-rail-no-dates-no-clear.md",
    "sha256": "11b5307046b7a56eb58f30593a217aa8994092e0682109a014a0536a182f58e5",
    "bytes": 7583,
    "original_title": "outcomes rail: no dates (old entries read as today), no way to clear; stale swarms linger forever",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the archived ticket text; the symptoms, delivered behavior, evidence, ledger-preservation bound, deployment details, and verification distinctions remain represented.",
    "dropped": []
  }
}
```

# BUG-070 — Old outcomes appeared current and crowded out new events

## Diagnosis

BUG-070 combined three display problems. The renderer discarded the date from existing ISO timestamps, bulk events required one-by-one dismissal, and the rail had no retention cap. Old entries therefore appeared current and accumulated until new outcomes were difficult to notice.

## Evidence

Before the fix, the dedicated fixture suite passed only 11 of 22 cases. Afterward, `verify:bug-070` passed 22/22, `verify:agent-outcomes` passed 45/45, and `verify:ui` passed 7/7. Typecheck and leak-gate were reported clean. `verify:rail-refresh` and `verify:bug-070-outcomes-rail` were named without recorded results.

## Implementation notes

Date labels distinguish today, yesterday, and older entries, including grouped-event headers. Section-wide and cluster dismissal persist through `dismissedAt`. The default rail limits recent undismissed entries, while an explicit show-all view exposes old or dismissed records. Briefing scope remains unchanged.

## Verification plan

Use a fixture ledger containing entries from today, yesterday, three days ago, and a 50-entry cluster. Confirm dated labels, persistent bulk dismissal, cluster dismissal, show-all behavior, and an unchanged on-disk ledger line count.

## Migration and rollback

The change was deployed on 2026-08-13 from commit `660fd87`; process 1162138 was recorded as running the latest code. Rollback can restore the prior display behavior because dismissal retains every ledger record.

## Risks

Dismissal must remain display state rather than deletion. Retention must limit only the default rail view, never truncate the ledger or alter briefing scope.

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
