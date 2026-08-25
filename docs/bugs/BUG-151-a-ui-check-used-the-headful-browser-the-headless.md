```orchard-ticket
{
  "id": "BUG-151",
  "type": "bug",
  "title": "A UI check used the headful browser; the headless one was broken",
  "summary": "A container session reached for Playwright first — correctly — and got \"Chromium distribution chrome is not found\": the image baked the MCP server but no browser, and container sessions got no --browser flag. It fell back to the headful stealth browser, putting a window in the user's workspace. Availability, not judgement.",
  "impact_if_we_wait": "Every container project with Playwright enabled lists ~24 browser tools that all fail on first navigate. Three are in that state today. The user never sees the error — only a silent downgrade to the headful browser, so ordinary UI checks keep interrupting them.",
  "current_need": "Independent clean-room verification: this changes the container image definition and a launch-time prompt surface, and the suite that passes it was written by the lane that built it.",
  "severity": "high",
  "area": "Browser / tool availability",
  "reported": "2026-08-25",
  "reported_by": "user",
  "owner": "you",
  "work_state": "in_verification",
  "human_action": "review",
  "updated": "2026-08-25",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A container session with Playwright enabled completes a real UI check (click, measure scroll, screenshot) headlessly, with no window",
    "The exact incident error is gone, and nothing tells a session to run playwright install",
    "The --browser argument is load-bearing: the old arg shape still fails on the new image",
    "A session is told at launch which browser is for what, and told loudly when Playwright is absent",
    "The note can never disagree with the tools actually attached",
    "No project is left with the headful browser as its only option"
  ],
  "code_refs": [
    {
      "path": "src/server/container/Dockerfile",
      "symbol": null,
      "note": "Bakes a pinned Chromium (playwright-core install --with-deps) and exports PLAYWRIGHT_BROWSERS_PATH. Replaces the comment that called the missing browser a deliberate open decision."
    },
    {
      "path": "src/server/container/provision.json",
      "symbol": "tools.playwright.browser",
      "note": "The browser pin. Changing it changes the image tag, so drift is detected instead of silently ignored."
    },
    {
      "path": "src/server/tools.ts",
      "symbol": "playwrightBrowserArgs",
      "note": "The bug: the container branch returned [], falling through to @playwright/mcp's absent chrome channel. Now returns --browser chromium."
    },
    {
      "path": "src/server/agent-bridge.ts",
      "symbol": "playwrightAvailabilityNote",
      "note": "Launch-time three-state note: Playwright is the default for ordinary UI work, stealth only for a logged-in profile or bot protection; absence stated loudly."
    },
    {
      "path": "src/server/agent-bridge.ts",
      "symbol": "browserAvailabilityNote",
      "note": "The stealth note now opens with not-the-default and points at mcp__playwright__* by name."
    },
    {
      "path": "scripts/verify-bug-151-playwright-first.mjs",
      "symbol": null,
      "note": "61 checks; drives the REAL image over REAL MCP stdio through a real click-and-measure-scroll check."
    },
    {
      "path": "docs/guide/integrations.md",
      "symbol": null,
      "note": "The browser section is now three capabilities, with the which-one-do-I-use rule."
    }
  ],
  "related": [
    { "id": "FEAT-105", "relation": "see_also" },
    { "id": "BUG-108", "relation": "see_also" }
  ],
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

# BUG-151 — A UI check used the headful browser; the headless one was broken

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-25 — user
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-08-25 — you
- **Diagnosis + fix:** Cause established before designing, and it was availability, not judgement. The user's own transcript (a container session, transcript c4d796c8) shows the session call mcp__playwright__browser_run_code_unsafe FIRST at 12:53:46 — exactly right for "does this page scroll to the form" — and get back `Chromium distribution 'chrome' is not found at /opt/google/chrome/chrome`. Only then did it use mcp__stealth-browser__*, which is host-side and headful, and the window appeared. Playwright WAS attached (both toggles really are on for that project); it just could not launch a browser, because the image baked the MCP server and nothing to drive, and playwrightBrowserArgs() returned [] for containers so @playwright/mcp stayed on its default system-Chrome channel. Reproduced byte-for-byte against the pre-fix image before writing anything. Fixed on three fronts: the image now bakes a pinned Chromium; tools.ts passes --browser chromium; and a launch-time note states the choice rule (Playwright for ordinary UI work, stealth only for a real logged-in profile or bot protection) on BOTH sides, since a session may read either note first. Fleet audit of the real registry: four projects have a browser; the three on container isolation were all in the broken state, and the one on direct isolation was fine. No project has the headful browser without Playwright. The headless question on FEAT-105 is the wrong lever and can be closed — stealth is headful by design, it was simply the wrong browser for this job.

### 2026-08-25 — you
- **Verification:** MUST-FAIL first, against the REAL pre-fix image: browser_navigate over MCP stdio returned, byte-for-byte, the error from the user transcript — Chromium distribution chrome is not found at /opt/google/chrome/chrome. Then verify:bug-151, 61/61. Section B drives the REAL rebuilt image over REAL MCP stdio against an HTTP-served below-the-fold page and answers the users actual question: click the CTA, scrollY goes 0 -> 1121, screenshot returns 10KB, all headless, with the image proven to carry no DISPLAY and no X socket so a window is impossible by construction. Section B2 is the discriminating one — the OLD arg shape run against the NEW image still returns the incident error, so --browser is load-bearing rather than the image change silently carrying the fix. Section D walks all 8 toggle/isolation combinations to prove the launch-time note can never disagree with the tools actually attached. Anti-regressions: verify:bug-108 playwright-pin 20/20 (it rebuilds the image; its B1 now shows --browser chromium), verify:tool-toggle 16/16, verify:browser-close 42/42, typecheck clean. One FEAT-105 assertion had to change and is called out honestly: it matched the literal source text browserAvailabilityNote(browserSettingsOf(opts.project).enabled), which broke when that value was hoisted into a const so the new Playwright note could share it — replaced with the property (source origin plus a behavioural claim) and a second check added. The new image tag is u1000-g1000-f0a874dd6b04 and has been prebuilt on this machine, so the users containers pick it up on the normal drift/recreate path rather than waiting on a cold build. Independent clean-room verification is warranted: this touches the container image definition and a launch-time prompt surface, and the suite that passes it was written by the lane that built it.
