```orchard-ticket
{
  "id": "BUG-139",
  "type": "bug",
  "title": "git crown chip renders undefined line counts from stale status payloads",
  "summary": "The git crown chip renders +undefined and −undefined when added/removed are absent because the renderer uses null-only guards. A stale pre-FEAT-099 server exposed the defect live.",
  "impact_if_we_wait": "Older servers, cached records, and partial/error-shaped status payloads show literal implementation values in a user-facing safety indicator.",
  "current_need": "none — the exact rendered-text check passes in the real browser; the suite FATAL that follows it is a separate, pre-existing defect and is now filed",
  "severity": "medium",
  "area": "git crown chip renderer",
  "reported": "2026-08-22",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-25",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Missing or non-finite added/removed/ahead/behind values never render.",
    "A clean tree suppresses the +0/−0 pair.",
    "Exact rendered text is covered for the captured stale payload, clean, no-upstream, detached, and normal statuses.",
    "The fixed chip is inspected in a real browser against an isolated scratch server."
  ],
  "code_refs": [
    {
      "path": "public/app.js",
      "note": "paintGitChip finite guards and clean-count suppression"
    },
    {
      "path": "scripts/verify-git.mjs",
      "note": "real-browser exact text-content regression coverage"
    }
  ],
  "related": [
    {
      "id": "FEAT-099",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": false,
    "Verification plan": false,
    "Migration and rollback": false,
    "Risks": true,
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

# Git crown chip renders undefined line counts

## Diagnosis
paintGitChip treated every value other than null as renderable. JavaScript makes undefined !== null true, so a status payload from an older server that omits FEAT-099 fields renders +undefined and −undefined. The producer and route are correct; the live process predates FEAT-099.

## Evidence
Captured live payload shape omits added, removed, and untrackedLinesIncluded while retaining repo, branch, dirty, ahead/behind, upstream, remoteUrl, and lastCommit. The user-visible chip was main · 2 dirty · +undefined · −undefined · ↑334.

## Risks
The chip is a safety summary. Tests must assert its complete rendered text rather than adjacent child spans. Regression honesty: regressed from FEAT-099 (b2bc67d), which shipped counts with a null-only guard and coverage that could not see the rendered text.

## Activity log

### 2026-08-22 — agent
- **implementation:** 2026-08-22 implementation: regressed from FEAT-099 (b2bc67d), which added counts with a null-only renderer guard and a test that asserted adjacent spans instead of the complete user-readable chip. Must-FAIL captured from the actual pre-fix paintGitChip source: expected `main · 2 dirty · ↑334`; actual `main · 2 dirty · +undefined · −undefined · ↑334`; exit 1. Renderer now accepts only finite added/removed/ahead/behind values. Deliberate neighboring choice: suppress +0/−0 when both finite counts are zero; null/absent/non-finite upstream divergence renders nothing. Added exact real-browser textContent fixtures for the captured stale payload, clean tree, no upstream, detached HEAD, and normal populated status. A server-free execution of the actual fixed renderer passes all five plus explicit NaN/Infinity coverage. Isolated real-browser verifier was attempted with a scratch dir and an OS-assigned port, but the dispatched worker's sandbox refused localhost listen with EPERM before server start; port 4317 was untouched.

### 2026-08-22 — agent
- **blocker:** 2026-08-22 environment blocker: required unpiped `npm run gate` was run twice and directly exited 1 because Node 24 ESM child_process cannot spawnSync git in this managed sandbox (EPERM after git returns status/output); typecheck and check-nul pass. Real-browser isolated-server verification is likewise blocked by localhost listen EPERM. Selective `git add -p public/app.js` re-read the file, rejected the unrelated curly-quote hunk, and selected only paintGitChip, but staging failed because .git/index.lock is read-only. Per the gate output, no commit was made. Port 4317 and the live service remain untouched.

### 2026-08-22 — board tool
- **Note:** 2026-08-22 verification (orchestrator, unsandboxed — the dispatched worker could not bind a socket or write .git): the real-browser suite now runs the exact-text check and it PASSES for all five payloads, including the captured stale shape rendering `main · 2 dirty · ↑334` with no counts. The worker's new fixture was BROKEN as written (referenced bare `state`/`paintGitChip`, which are module-scoped; the page threw ReferenceError and the suite aborted before reaching it) — fixed to use window.__station, and paintGitChip exported there. The fixture now also RESTORES the real status afterwards so it does not poison the workbench assertions below it. Real busy repo renders `main · 63 dirty · +13984 · −4 · ↑1`. 74 PASS. `npm run gate` PASS unpiped (exit 0) after scrubbing a home-path leak the worker introduced in both the fixture and this ticket. Committed ad8212f, staging FILTERED hunks: the unrelated curly-quote hunk at app.js:914 was re-read and deliberately left unstaged, as was BUG-140 (another lane). PRE-EXISTING, not introduced here: the suite FATALs late in history pagination ("history load more" 20s timeout); reproduced IDENTICALLY at HEAD in a clean worktree, so FEAT-099's 73/73 claim never covered the tail of its own suite. NOTE FOR THE USER: the live chip will keep omitting the counts until the claude-station service restarts onto current code — the running process predates FEAT-099 by 14h. Not restarted here by instruction.

### 2026-08-25 — worker
- **bookkeeping-sweep:** 2026-08-25 bookkeeping sweep (authorised by the user). Re-ran `npm run verify:git` at HEAD b6c0151 on the host. This ticket own check PASSES on rendered text for all five payloads: stale server payload renders `main · 2 dirty · ↑334` with no counts, clean tree `main`, no upstream `topic · 1 dirty · +3 · −2`, detached `detached @ abc1234 · 1 dirty · +4 · −1`, normal `main · 2 dirty · +7 · −3 · ↑4 · ↓2`. 69 checks pass before the run stops. The fix is committed (ad8212f, log correction 8967490). The suite still FATALs LATER, in history pagination — `.gt-more` is clicked, no 51st row ever arrives within 20s, and the next line then throws on an undefined row. That is reproduced again today, it is NOT this fix, and it is now filed as its own ticket so it stops being carried as a footnote on two tickets. Closing BUG-139 as verified. Symptom of a deeper design flaw? Handed forward as written on the ticket: a safety chip was tested on adjacent spans instead of on the text a person reads, which is how the undefined survived FEAT-099.
