```orchard-ticket
{
  "id": "FEAT-163",
  "type": "feature",
  "title": "Non-git projects show no git control in the session bar",
  "summary": "A project whose directory is not a git repository shows no git icon in the session top bar at all, so there is no way from the bar to start version control. The bar should still show the git control and offer to initialise a repository, with a confirmation.",
  "impact_if_we_wait": "Users of non-git projects have no visible git affordance in the session view; the only init path is buried in the settings drawer.",
  "current_need": "Show the git control for non-git projects with an Initialize repository action that runs where the project files live.",
  "severity": "low",
  "area": "session top bar / git readout",
  "reported": "2026-10-05",
  "reported_by": "agent",
  "owner": "agent",
  "work_state": "in_verification",
  "human_action": "none",
  "updated": "2026-10-05",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A non-git project shows the git control in the top bar, in a distinct not-a-repo state.",
    "Activating it offers Initialize git repository behind a confirmation; confirming runs the server-side init and the bar then shows the repo.",
    "Init runs in the project directory that the project files live in for both direct and container projects (a container project bind-mounts that same directory)."
  ],
  "code_refs": [
    {
      "path": "public/app.js",
      "symbol": "paintGitChip"
    },
    {
      "path": "src/server/git.ts",
      "symbol": "init"
    }
  ],
  "related": [
    {
      "id": "FEAT-139",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
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

# FEAT-163 — Non-git projects show no git control in the session bar

## Symptom

User report: in a session of a project that is not a git repository, the top bar has no git icon at all.

## Diagnosis

Verified before building: the project directory is not a git repository (`rev-parse --show-toplevel` fails there), and `paintGitChip` hides the chip whenever the status says `repo: false`. The comment on that function records it as deliberate ("hidden entirely for non-repos"). The server already has an init action (`POST /api/projects/:id/git/init`), reachable only from the settings drawer.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-05 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-05 — worker (fixing r1)
- **Fixing round 1:** Fixing round 1 (dispatch phase=fixing round=1 class=fix).
  - **Understood / hypothesis verified first:** the reported session belongs to a registry project with isolation=direct whose directory is NOT a git repository (`rev-parse --show-toplevel` fails there). `paintGitChip` hid the chip whenever status.repo was false, by design ("hidden entirely for non-repos"). Hypothesis confirmed; no other cause.
  - **Changed:** the chip now renders for a non-repo in a distinct state (dashed hollow ring + "no git", aria-label says so). Hover/focus/click opens the git popover (#gitPop) with "Not a git repository", the project dir, and "Initialize git repository"; clicking arms an explicit confirm ("Run git init here?" Initialize / Cancel, confirm focused); confirming POSTs the existing server action `/api/projects/:id/git/init` (git init -b main in project.hostPath, refuses if already a repo). A failed init shows the server's error (clamped to 4 lines, full text on hover). A missing project dir or an unknown status still hides the chip.
  - **Container vs direct:** init runs server-side in project.hostPath for both; container-manager `desiredBinds` bind-mounts that same hostPath read-write as the container workdir, so the .git lands where the container's files are. The popover says "mounted into the container" for a container project.
  - **Verified:** `node scripts/verify-feat-163-165-git-bar.mjs` -> "FEAT-163/164/165 git bar: 45 passed, 0 failed" (Playwright headless Chromium, isolated scratch server, own CLAUDE_STATION_DATA, free port). FEAT-163 checks: chip shown in "no git" state; click pins popover with Initialize (both themes); confirm step + Cancel disarms with no .git (both themes); the REAL server init reached (one POST) and its refusal shown, no .git created; init success path flips the chip to the repo state. Non-git fixture is SYNTHETIC (scratch dir shaped like a web project) — the user's real project was not clicked.
  - **Must-FAIL:** the same suite against a pre-change copy of the tree: "[163-nongit] section threw: page.waitForFunction: Timeout 30000ms exceeded" (chip never shown) — 4 of 4 feature sections FAIL there.
  - **Not verified (honest):** a SUCCESSFUL real `git init` from the UI. This lane's PATH carries the FEAT-135 git shim, which the scratch server inherits and which refuses repo-creating commands; the success path was graded with the init response stubbed at the browser. A user-run pass can set F163_REAL_INIT=1 to require the real init.
  - Screenshots: docs/bugs/assets/FEAT-163-{face,popover,confirm}-{light,dark}.png, FEAT-163-init-refused-light.png.
  - Changed files (unstaged; no git writes): public/app.js, public/index.html, public/styles.css, public/lib/git-view.js, public/git-view.css, scripts/lib/git-grant-store.mjs, scripts/lib/git-grant-store.d.mts, scripts/git-grant.mjs, src/server/registry.ts, src/server/index.ts, package.json (two verify script entries), new scripts/verify-feat-163-165-git-bar.mjs, new scripts/verify-feat-164-permanent-git-grant.mjs. Gate: `npm run gate` -> GATE: PASS (exit 0; leak-gate, check-nul, typecheck).
  - **Handoff:** independent clean-room verification owed (class=fix, routine UI; the init call is a pre-existing server route). Next verifier: run with F163_REAL_INIT=1 outside an agent shim, and try a container-isolation project.

### 2026-10-06 — worker (verifying r1)

  - **Real `git init` success path exercised (F163_REAL_INIT=1, isolated scratch server, free port).** `scripts/verify-feat-163-165-git-bar.mjs` → 43 passed, 1 failed; the single FAIL is the REAL init path ("confirm runs the server init … chip flips to a repo", observed `git:false` — no `.git` created). This is the agent-lane git guard CORRECTLY refusing `git init` (BUG-230 fixed → the lane's FEAT-135 shim survived the scratch server boot; a direct `git init` is likewise guard-blocked). Everything else — the non-git init OFFER, confirm/cancel arming, diffstat face/popover on the real busy + moderate checkouts, and the FEAT-164 grant flow — passed 43/43.
  - **Command the USER runs to exercise the real success path** (outside the agent guard, in a plain shell where `git init` is permitted): `F163_REAL_INIT=1 node scripts/verify-feat-163-165-git-bar.mjs`.
  - **Live smoke (read-only, Playwright headless, running service):** non-git project (cl-1) shows "Not a git repository" + "Initialize git repository" offer (NOT clicked). Screenshot docs/bugs/assets/SMOKE-live-nongit-init.png. No page errors; no write route driven.
