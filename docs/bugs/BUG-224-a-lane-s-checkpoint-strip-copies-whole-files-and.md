```orchard-ticket
{
  "id": "BUG-224",
  "type": "bug",
  "title": "A lane's checkpoint strip copies whole files and reverts other lanes' work",
  "summary": "The FEAT-157 strip lane restored 22 shared files by copying its pre-lane snapshots over them. That silently removed BUG-217's finished round-9 wiring from index.ts four seconds after BUG-217's fixer went green, and the next verify ran red. Its no-foreign-hunks proof compared the wrong pair of files.",
  "impact_if_we_wait": "Any lane that checkpoints or strips can erase another lane's verified work in a shared file with no warning. The loss surfaces only as a later red verify, and each one costs a full fix/verify round.",
  "current_need": "Build a mechanical strip helper that reverse-applies only the lane's own recorded patch and refuses otherwise.",
  "severity": "high",
  "area": "lane process / checkpoint protocol",
  "reported": "2026-09-30",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-09-30",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A lane's strip of a file another lane also changed removes only the stripping lane's hunks and leaves every other line intact.",
    "A strip whose own hunks do not reverse-apply cleanly refuses and names the file, never overwrites it.",
    "Must-FAIL: the whole-file copy used on 2026-09-30 loses the other lane's hunk; the helper keeps it."
  ],
  "code_refs": [
    {
      "path": "docs/CONVENTIONS.md"
    },
    {
      "path": "src/server/index.ts"
    }
  ],
  "related": [
    {
      "id": "BUG-217",
      "relation": "see_also"
    },
    {
      "id": "FEAT-157",
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
    "Verification plan": true,
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

# BUG-224 — A lane's checkpoint strip copies whole files and reverts other lanes' work

## Symptom
A lane's "restart checkpoint" strip silently reverted another lane's finished, green work in a shared file. BUG-217's round-9 fixer wired the data-dir lock, the exit-78 refusal and the exit-75 drift exit into `src/server/index.ts` and ran its suite 156/0. Four seconds after that fixer wrote its log entry, the FEAT-157 strip lane copied a pre-lane snapshot of `index.ts` over the file. The next independent verify found the wiring absent and ran the suite red, and a whole fix/verify round was spent on a tree that no longer held the fix.

## Evidence
- `src/server/index.ts` mtime 2026-09-30 12:40:38.742Z. FEAT-157 lane (agent afd45cbe0e3da5d0e, session 4ea3d0d2) ran, at 12:40:38.689Z: `for f in $files; do cp "$PRE/$f" "$f"; done` over 22 files with `PRE=~/.local/state/claude-station/scratch/feat157/prelane`; output "restored 22", "all 22 match prelane".
- The pre-lane `index.ts` copy has mtime 09:51 local (it was taken at the lane's start, 11:07). After the restore, the live file is byte-identical to it (`cmp` equal).
- BUG-217 round-9 fixer (agent ac0f35b679776e1e5) edited `index.ts` at 12:06:48Z and appended its log at 12:40:34Z. Its transcript's edit is byte-identical to the BUG-217 hunks in `scratch/feat157/wip/full/src/server/index.ts`, the FEAT-157 lane's own WIP copy. So the strip lane HAD the other lane's hunks in hand and removed them.
- FEAT-157's log entry for the strip says: "for ALL 22 FEAT-157-modified files, current == WIP byte-for-byte, proving no other lane touched them since the 11:07 pre-lane snapshot → ZERO foreign hunks". That inference is wrong: current == WIP only proves nothing changed since the WIP copy was taken. The WIP copy already contained BUG-217 rounds 7–9 (made after 11:07), so pre-lane → WIP was FEAT-157 plus foreign hunks.

## Diagnosis
The CONVENTIONS checkpoint protocol step 4 says to reverse-apply only your own hunks on a file other lanes also changed, and never to restore a whole file there. The strip lane substituted a whole-file copy, justified by a proof that compared the wrong pair: current vs WIP, instead of (pre-lane + own patch) vs current. Nothing mechanical stops a lane from copying a snapshot over a shared dirty file. The only safeguard is prose, and a lane can reason past prose.

## Fix design
Make the strip mechanical, so a lane cannot express a whole-file restore on a shared file. A checkpoint/strip helper takes the lane's OWN recorded patch (a diff captured from its edits, not derived from snapshots) and runs `git apply -R --3way` per file. It refuses, naming the file, when a hunk does not reverse-apply cleanly. A pre/post check asserts that every line outside the lane's own hunks is unchanged. The command guard should also flag `cp <scratch>/pre*/… <tracked file>` onto a file that `git diff` shows other changes in.

## Verification plan
Must-FAIL: two lanes edit one file, and lane A strips with the current whole-file copy. Lane B's hunk is gone (pre-fix). Through the helper, B's hunk survives and A's hunks are gone (post-fix). A case where A's hunk cannot be reverse-applied cleanly must refuse, not overwrite.

## Scope of this incident not audited
Only `index.ts` was checked for foreign hunks (BUG-217's). A per-file ticket-id scan of the other 21 restored files (pre-lane vs WIP) shows mostly FEAT-157 references, plus FEAT-151, FEAT-155, BUG-218, BUG-107 and FEAT-113 mentions in container-manager.ts, provisioning.ts, templates.ts, Dockerfile and provision.json. Whether those were foreign hunks or FEAT-157's own text was not established. `public/app.js` (FEAT-129 lock) was among the 22.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-30 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-09-30 — audit lane (finding, round 1, class=explore) — scope of the 12:40:38Z strip: ONE foreign ticket lost work, already restored
- **Correction to the brief's window.** The pre-lane snapshot is `prelane/when` = 2026-09-30T11:07:25**+03:00** = **08:07:25Z** (not 11:07Z). The machine is EEST; the ticket's "12:06:48Z" for BUG-217 r9 is the true UTC transcript time. So the at-risk window per file is from its own pre-lane copy (08:07:25Z for most; drawer.js 08:07:27Z, verify-bug-214-218 08:54Z, verify-bug-107 09:01Z, verify-feat-151-* 09:40Z) to the `cp` at 12:40:38.689Z.
- **The 22 files** (strip lane afd45cbe0e3da5d0e, transcript line 64): package.json, public/{app.js, lib/api.js, lib/drawer.js, styles.css}, scripts/verify-{bug-107-image-staleness, bug-214-218-base-lifecycle, feat-151-container, feat-151-runtime-update, feat-155-image-env-policy}.mjs, src/server/{agent-bridge, board, container-manager, dispatch-broker, index, provisioning, registry, templates, validate}.ts, src/server/dispatch-client.mjs, src/server/container/{Dockerfile, provision.json}. It also `rm`'d 7 FEAT-157-created files (all FEAT-157's own).
- **Method (ground truth, not inference).** The strip lane's own check at 12:39:56Z proved `wip/full` == live tree for all 22 files, 42 s before the `cp`. So `diff -u prelane/<f> wip/full/<f>` is EXACTLY what the strip removed, whoever wrote it (Claude, codex dispatch, human). Each hunk (114 hunks across 22 files) was attributed by (a) its content and (b) a scan of every transcript under `~/.claude/projects/<this repo's encoded path>/**` (all account dirs symlink here) for Edit/Write/MultiEdit and file-writing Bash (python/sed -i/cat >/cp) naming any of the 22 files, 08:07:25Z–12:40:38Z; then each hunk's added lines were searched for in the file on disk now. The 42 s gap had no write to the 22 files except the strip's own. Scripts: `~/.local/state/claude-station/scratch/bug224/{scan,attr,idx}.mjs`.
- **Result: 112 of 114 removed hunks are FEAT-157's own** (agent a98ffe99360cbad43, the FEAT-157 build lane, 08:07–12:37Z). They sit in all 22 files. The other 2 hunks are BUG-217's, both in index.ts. The FEAT-151 / FEAT-155 / FEAT-113 / BUG-107 / BUG-218 mentions flagged under "Scope … not audited" are FEAT-157's text quoting those tickets, not foreign hunks. The BUG-214/218 fixer (ad30766fc1ba13d7c) ended at 08:06:41Z, before the snapshot, so its work was in `prelane` and survived (`refuseDestroyIfLive` and `claude-station.role=session` are in prelane and on disk now).
- **Foreign edits removed by the strip: 3, one ticket, all in `src/server/index.ts`, all present again now:**

| file | agent | ticket | edit | present now? | board now |
|---|---|---|---|---|---|
| src/server/index.ts | a742d4cb96b17014c (09:43:29Z) | BUG-217 r7 | data-dir lock block after `ensureDir(dataDir())` | yes (superseded text; r10 restore) | in_progress / IN-PROGRESS |
| src/server/index.ts | a62f286a75ba45579 (11:04:45Z) | BUG-217 r8 | lock comment → flock on `.orchard-server.lock` | yes (superseded by r9; r10 restore) | in_progress |
| src/server/index.ts | ac0f35b679776e1e5 (12:06:48Z) | BUG-217 r9 | lock on the data DIRECTORY inode + exit-75 drift + re-confirm line | yes: hunk @5482 35/35 lines, @5560 1/1 (restored 13:16:41Z by acd484d86ad05cc27, BUG-217 r10) | in_progress |
| 21 other files | a98ffe99360cbad43 | FEAT-157 | own build (base releases/notice) | no, by design (the strip's purpose) | blocked / BLOCKED |

- **False done/verified records caused by the strip: none.** BUG-217 is in_progress, not done. BUG-214 and BUG-218 are `verified` (placement Done), but their fix code predates the snapshot and is on disk. Their r10 record lane (afbf9925a0652e53e) re-ran the suite on the post-strip tree, 37/37. **Side effect to note for FEAT-157's resume:** that lane re-applied, by hand, one FEAT-157 hunk to `scripts/verify-bug-214-218-base-lifecycle.mjs` (the `seedId()` legacy-base seed). The file changed at 13:14:36Z, so FEAT-157's saved patch will conflict there on `git apply --3way`.
- **Live activity now (13:44Z):** no lane has written any of the 22 files since index.ts at 13:16:41Z. Twenty of them are still byte-identical to `prelane`. BUG-217 r10 verify (a7ab65541a3b7888e) is running and reads index.ts. FEAT-157 is BLOCKED, so no resume is pending.
- **Not checked:** edits that another lane made *and then removed itself* inside the window. The strip cannot lose those, so they are out of scope. I restored nothing, as chartered.
