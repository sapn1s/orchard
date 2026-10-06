```orchard-ticket
{
  "id": "FEAT-159",
  "type": "feature",
  "title": "Settings rows change value on click instead of offering a real control",
  "summary": "In Settings, the Model, Effort, Spend cap, Permission mode and snapshot-retention rows silently step to the next value when clicked. There is no dropdown, no way to type a custom model, and nothing says what an unset row falls back to. The user asked for each setting to get the control its value needs, with the scope shown clearly.",
  "impact_if_we_wait": "Changing the model means clicking through a list you cannot see, and it is easy to land on a value you did not want. A custom model id can only be set machine-wide.",
  "current_need": "fix",
  "severity": "medium",
  "area": "UI settings modal",
  "reported": "2026-09-30",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "in_progress",
  "human_action": "none",
  "updated": "2026-09-30",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Each value row uses a fitting control: a model select with a Custom free-text option, selects for enums, a number field for spend",
    "Clicking a row never changes a value; only the control does",
    "Each control names what the unset choice falls back to (machine default, project value or built-in), and reset still works",
    "Model set, clear and custom id round-trip through the real server, covered by a checked-in suite",
    "Existing settings suites stay green; npm run gate passes"
  ],
  "code_refs": [],
  "related": [
    {
      "id": "FEAT-146",
      "relation": "see_also"
    },
    {
      "id": "FEAT-139",
      "relation": "see_also"
    },
    {
      "id": "BUG-208",
      "relation": "see_also"
    },
    {
      "id": "ARCH-018",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "plan+review",
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

# FEAT-159 — Settings rows change value on click instead of offering a real control

## Symptom

User, verbatim-ish: "We have this in settings, supposed ability to change models, but first of all the UI is a mush. Rework the settings modal in general, the components are not intuitive currently. E.g. this setting [Model / --model, shows 'machine · global default · claude-opus-5-5'] — I can click it and it just changes type instead of e.g. being a dropdown or entering a custom model. But there is a lot more to it, really the UI/UX needs rework by a knowledgeable agent."

## Context pack

- `public/lib/drawer.js` `row()` with `opts.cycle`: the whole row is a button whose click calls `cycle(field, list)`, writing the NEXT value in a hidden list. Used by Model (`modelPane`), Effort, Spend cap (`BUDGET_CYCLE`), Permission mode (`PERM_CYCLE`); snapshot retention uses the same idea with `KEEP_CYCLE`.
- What the user read as "changes type": the first click writes a project value, so the provenance chip flips from hollow `machine` to filled `project` and the value jumps to the next catalog entry.
- The machine-scope Default model (New-project defaults) already has a real select plus an "Other model id" free-text field; the project and session rows never got one.
- Related: FEAT-146 (the modal, the chip, the four-column row), FEAT-139, BUG-208 (project-scope model catalog ignores the project provider), ARCH-018 (provenance is re-derived per reader).

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-30 — user
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-09-30 — fixing lane (round 1, class=fix) — every value row gets a real control
_Dispatch: phase=fixing round=1 class=fix._

- **Understood / hypothesis check:** the orchestrator guessed a generic row whose click cycles the *scope*. Close but not quite: the click cycled the *value* (`row()` with `opts.cycle` → `cycle(field, list)` wrote the next entry of a hidden list), and because the first click turned an inherited value into a project value, the provenance chip flipped `machine` → `project`, which is what the user read as "changes type". The same cycle idiom drove Model, Effort, Spend cap, Permission mode, snapshot Keep, and three container rows (Memory cap, GPU, Repo at). There was no project/session model picker and no way to enter a custom model below machine scope.
- **Audit (before, both themes, all 12 categories):** `docs/bugs/assets/FEAT-159-before-{dark,light}-<cat>.png` + `-model-session`. Defects: (1) cycle rows look like static text and write on click; (2) first click silently converts inherit → set-here; (3) Model shows `global default · claude-opus-5-5` in wrapping mono beside a `machine` chip that says the same thing; (4) no custom model id at project/session scope; (5) Permission mode shows raw enum keys (`acceptEdits`, `bypassPermissions`); (6) tool-list inputs are borderless right-aligned mono, indistinguishable from a read-only "none"; (7) the unset state never names what it falls back to in the control itself; (8) machine pane wording differs ("Other model id — type it…", "(custom — not in the CLI's list)", lowercase effort).
- **Changed (unstaged):**
  - `public/lib/drawer.js` — `row()` rebuilt: a row is inert; column 3 holds a real control. `selectControl` (dropdown; first option "Use machine default (X)" / "Use project value (X)" / "Use built-in default", concrete values under an optgroup "Set for this project" / "Override for this session"; a stored value outside the list shows as "X (custom)"); `customEditor` ("Custom model id…" opens a field under the dropdown in the value column; Save live-gated by the server's MODEL_RE, Cancel/Esc write nothing, typed text survives background repaints via `d.customEdit`); `moneyControl` (dollar field, empty = no cap). Model/Effort/Spend cap/Permission mode, snapshot Keep, Memory cap, GPU and Repo-at converted; `cycle()` and every `set-main`/`data-cycle` deleted. `resetTarget` formats with the row's labels. Esc ladder: an open custom editor is the innermost thing Esc closes. Machine pane: wording unified ("Custom model id…", "(custom)", effort labels). Stored values and write paths are unchanged — no data migration.
  - `public/app.js` — ctx `sessionModelCycle` replaced by `sessionModelOpts` (same `activeModelOpts()` source, with labels).
  - `public/styles.css` — `.ssel` / `.smoney` / `.snum` field boxes, `.set > input.vin` gets the same box, `.set-edit*`, `.mini.primary`; the cycle-row subgrid rules deleted; value rail 200 → 260px so "Use machine default (claude-opus-5-5)" fits. Only existing tokens used.
  - New suite `scripts/verify-feat-159-settings-controls.mjs` (32 checks). Updated for the deliberate change only: `verify-feat-146-settings-rows.mjs`, `verify-feat-146-settings-polish.mjs`, `verify-feat-118-ui.mjs`, `verify-bug-196-matrix.mjs`, `verify-feat-155-container-ui.mjs`, `scripts/qa/settings-sections.spec.ts`.
- **Verified:**
  - `node scripts/verify-feat-159-settings-controls.mjs` → PASS 32/0, real isolated server (isolatedServerEnv, scratch CLAUDE_STATION_DATA/CLAUDE_PROJECTS_DIR, free port), real cached CLI catalog, every write read back from the server: row-label clicks write nothing; catalog pick stores; "Use machine default" clears to null; custom id refused when malformed (Save disabled, reason shown, nothing written), stored when valid, shown as selection after a full reload, pre-filled on re-open; Esc cancels without writing and keeps the modal open; Effort/Permission/Spend cap store the same values as before; session lens writes an override and leaves the registry alone; Tab reaches the ⓘ; container Memory/GPU/Repo-at store; must-FAIL: a synthesized drawer.js with a click-to-write row turns check 1 red.
  - `verify-feat-146-settings-polish.mjs` PASS 81/0; `verify-feat-118-ui.mjs` PASS 15/0; `verify-bug-196-matrix.mjs` PASS 465/465 (drawer session-model cells now driven through the dropdown); `verify-bug-101-contrast.mjs` exit 0; `npm run gate` PASS.
  - `verify-feat-146-settings-rows.mjs` 58/1 — the one red is the Dockerfile ⓘ description (`WHY['container.dockerfile']`) added by another lane's uncommitted FEAT-155 work, not by this change. `verify-feat-146-settings-shell.mjs` — one red, "11 categories", because another lane's uncommitted Runtime category makes 12. `verify-feat-146-settings-content.mjs` 130/9 — all nine are the git-repo shapes (agent git-write guard refuses `git init` in the fixture) and the services must-FAIL whose anchor moved with the other lane's `envGroup`; every settings-row probe passed. `verify-bug-183-css-tokens.mjs` section A (no undefined token) passes; its B failure is `--sess-run` in committed CSS.
  - Visual: after screenshots `docs/bugs/assets/FEAT-159-after-{dark,light}-<cat>.png`, `-model-session`, `-model-custom`. Two independent critique passes (fresh subagent, screenshots + requirement only). Addressed: inherit vs set made explicit (Use… + optgroup), editor kept in the value column with Cancel/Save grouped, Save disabled while invalid, invalid border, dropdown shows "Custom model id…" while editing, machine/project wording and effort casing unified, tools placeholder.
- **Could not test:** `scripts/qa/*.spec.ts` — Playwright Test loads 0 tests on this machine for EVERY spec (`test.beforeAll() … not expected here`), untouched specs included; environmental, not this change. `verify-feat-155-container-ui.mjs` not run (needs a Docker daemon); its memory-cap step was rewritten for the dropdown and the same write is covered by section 8 of the new suite. Native `<select>` popups are not visible in headless screenshots, so the optgroup heading was verified in the DOM, not by eye. No screen reader run.
- **Declined from the critique (with reason):** a per-row scope toggle and a labelled reset button (the FEAT-146 chip + ↩ gutter are decided design); chip loudness; integration switch placement, Account row, snapshots actions, the New-project defaults intro text, Isolation warning styling — outside the value-control rework, worth their own pass.
- **Still open / handoff:** BUG-208 still applies — the project-scope Model dropdown lists the Claude catalog even on an OpenAI project (now a visible list instead of a hidden cycle, same data). The machine pane's model picker is still its own markup (`#gModelSel` + always-visible custom row); folding it onto `selectControl` would give one model picker (ARCH-010) but moves ids three suites pin. Needs an independent clean-room verify before VERIFIED.
- **Symptom of a deeper design flaw?** not closing — not answered yet.
