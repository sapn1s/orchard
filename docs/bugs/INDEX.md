# Board

See `README.md` (append-only tickets; every agent reads the whole ticket + appends).
Owner: 🤖 = subagent in flight · 👤 = needs you · — = queued/unassigned.

## Open

| ID | Title | Owner | Status | Sev |
|----|-------|-------|--------|-----|
| FEAT-049 | Publishing the project would expose private details permanently | 👤 | OPEN — NEEDS A HUMAN DECISION (2 options). Recommended: A — The risky part is the run itself, and keeping one ticket attached to it costs nothing and reverses in a line. If we wait: Nothing leaks while the project stays private, because the release steps only run when a person runs them. Bounded: this is exposure-on-publish, not a live disclosure, and no data is lost by leaving it open. | med |
| FEAT-033 | Tool adoption stayed deliberate instead of accumulating unused tools | 👤 | OPEN — NEEDS A HUMAN DECISION (2 options). Recommended: A — The three candidates it existed to evaluate are all settled, and reopening or refiling later costs one ticket. If we wait: The ticket stays open as a low-priority note and nothing breaks. Bounded: both adopted tools are already in use, and the parked candidate blocks no work. The only cost is a stale entry on the board. | low |
| FEAT-023 | Running sessions on another machine is not possible yet | 👤 | OPEN — NEEDS A HUMAN DECISION (2 options). Recommended: A — Its size and blocking security requirements make starting before the foundation lands more expensive than waiting. If we wait: Cross-machine work stays impossible and the design stays cold. Bounded: nothing breaks, no shipped behaviour is affected, and no user data is at risk — the ticket is a parked design, not a defect. | low |
| FEAT-030 | No way to pass matured findings between projects | 👤 | OPEN — NEEDS A HUMAN DECISION (2 options). Recommended: A — The need is genuinely rare and the manual workaround costs almost nothing, so this can wait without accumulating harm. If we wait: Occasional handovers stay manual, roughly a few times a year. Bounded: nothing breaks and no work is lost, since copying a note across by hand still works and no existing project behaviour depends on this. | low |
| BUG-048 | Restart survivors delay new messages | 👤 | OPEN — NEEDS A HUMAN DECISION (4 options). Recommended: A — It makes the current safe behavior honest while preserving a reversible path toward shorter waits. If we wait: Messages remain silently delayed for about a minute after some restarts. Bounded: this is temporary delivery latency, not message loss or conversation corruption, and normal operation is unaffected. | low |
| FEAT-086 | No way to see which parts of the workflow cost the most | 👤 | IN-PROGRESS The capture layer is built and recording; what remains is deciding whether the breakdown also needs a rendered view, or whether the command-line report is enough. If we wait: If usage is ever limited, a decision about what to cut would be made blind. Bounded: nothing breaks and no data is lost while this stays queued, since it only reads records that are already retained. | low |
| FEAT-087 | Tickets read as agent notes and people skip the headings | 👤 | OPEN — NEEDS A HUMAN DECISION (2 options). If we wait: New tickets keep being written in vocabulary a reader never agreed to, so the durable record stays hard to read. Bounded: this is presentation and wording, not content. Every existing ticket keeps its full detail and the board tooling keeps working. | med |
| FEAT-088 | Ticket readability check misses repetition and ordering faults | 👤 | OPEN — NEEDS A HUMAN DECISION (3 options). Recommended: C — It gathers the firing rate needed to choose between the other two, and it can be switched to blocking later without rework. If we wait: Decision tickets keep reaching people in a shape that is slow to read, and the judgement-level faults stay unflagged. Bounded: the mechanical lint already catches repetition and ordering, and no ticket content or existing check is affected. | med |
| FEAT-090 | Decisions can be answered on the ticket and handed to an agent | — | OPEN — awaiting your review If we wait: The reply control may ship cramped or hard to reach on a small screen. Bounded: this is layout and readability, not the answer record, which is appended with author and time and still reaches an agent. | med |
| FEAT-082 | Finished and unfinished tickets look the same on the board | 👤 | OPEN — NEEDS A HUMAN DECISION (4 options). Recommended: C — It gives new tickets a number worth trusting while still showing something useful on the ones already written. If we wait: Confirming that a requested feature is actually done stays a manual read of a long history log. Bounded: this is a presentation and navigation gap, nothing is lost or wrong in the tickets themselves, and the board keeps working as it does today. | med |
| ARCH-004 | Open tickets silently disappear from the board | — | IN-VERIFICATION An independent clean-room pass on round 7, which is the only round self-verified so far; the canonical state itself is built and every board tool reads it. If we wait: Open work can remain invisible until someone notices an incorrect count. Bounded: this affects ticket discoverability and display-correctness, not ticket contents or user data. Manual flag corrections address known cases but not recurrence. | high |
| ARCH-005 | Project views can show another project's live activity | — | OPEN Build option 2: the server states which project owns a live session, and each project's view carries its own live state, so a surface reads the selected project's activity instead of working ownership out. If we wait: Three known displays remain misleading today, and further views may repeat the fault. Bounded: this affects display correctness and trust in a single-user local tool, not security between users, data loss, corruption, or another person's information. | med |
| BUG-104 | Verifier can still read the methodology the clean room removes | 👤 | OPEN — NEEDS A HUMAN DECISION (4 options). If we wait: A safety property a great deal of trust rests on is weaker than stated. Bounded: the exposure is passive and nothing reaches the prompt. No verifier is known to have read those files, and no past verdict is shown to be wrong. | med |
| FEAT-092 | Running sessions keep following outdated project instructions | 👤 | OPEN — NEEDS A HUMAN DECISION (2 options). If we wait: The session you talk to all day can quietly follow superseded rules, and it cannot tell that it is doing so. Bounded: this affects instruction freshness, not user data, and cycling the session or handing it the changed document remains a cheap workaround. | med |
| ARCH-006 | Renderers can silently hide content with mixed line endings | — | OPEN Build option A: inventory the model, transcript and file entry points, canonicalize text as it arrives one entry point per commit, and drop a renderer's own rule only once every source feeding it is canonical. If we wait: New renderers can silently hide or delete content, repeating three instances found in one day. Bounded: this affects local display-correctness, not security, deployed systems, other users, or their data. | med |
| BUG-108 | Browser automation tooling was downloaded fresh at every session start | 👤 | OPEN — NEEDS A HUMAN DECISION (2 options). If we wait: Every opted-in session start trusts whatever the registry serves that moment, and sessions cannot start offline. Bounded: only browser automation is affected, no stored project data is at risk, and the equivalent work for the code-navigation tool already shipped. | high |
| FEAT-091 | split a reply into what is addressed to you and what is me narrating | — | OPEN — spec + enforcement half BUILT (`0354e5b`); renderer half BUILT (`8ab4cb9`). TENTH clean-room verdict was BROKEN, in the WRONGLY-LITERAL direction: a LINK REFERENCE DEFINITION can span LINES (label, destination and title may each sit on their own), so `[ref]:` / `/url` / `===` resolves out of the paragraph to the reference, leaves it OPEN, and keeps the fence LIVE — while a one-line notion of a definition made `===` a setext heading, closed the paragraph, let condition 7 fire, and LOST a well-formed `orchard-notes` fold: `blocks: []`, its narration exposed in the real accessibility tree, and `inert-html:orchard-notes` reported as uncertainty on VALID input. Fixed as the CLASS: the paragraph now carries its accumulated content and definitions are resolved off it by a PORT of the reference's own `parseReference`, at the one place the reference runs it. Every other multi-line construct enumerated and accounted for; no new documented limitation. The randomised differential now generates multi-line constructs (0 hiding / 0 over-recognition / 0 lost at 1,000,000 documents, where round-9 scores 8,930) and its non-vacuity calibration is a TABLE over every prior generation. See the 2026-08-19 TENTH-verdict entry at the foot of this ticket. ELEVENTH clean-room verdict was **HOLDS** with one residual — the randomised fuzz corpus was graded in node only, never rendered, and the theme dimension was unprobed. That residual is now CLOSED and STANDING: the fuzz generator moved into the shared corpus module (proven byte-identical, 80,000 documents), leg **[R]** renders a 20,000-document stratified sample of it per run (measured 0.13 ms/document) graded against the CommonMark reference in BOTH directions and against a real accessibility tree, non-vacuity proven by serving `91b35ab` and `52807b9` parser bytes over CDP interception (F3=53 and F1=1,758 where current scores 0), and leg **[T]** proves a closed fold is closed in PIXELS in both themes. Truncated/partial messages probed for the first time: 169,828 prefixes, 0 violations. Independent clean-room verify still REQUIRED before VERIFIED — this round's leg was written and graded green by the same author, and that is the only thing still blocking it. **ROUND 12 (2026-08-19): the VOCABULARY was replaced.** The two presentation-era names encoded where a passage appears, not what it is, which is why narration kept landing in the visible block. Layer 2 is now six SEMANTIC categories derived from a labelled random sample of 155 real passages — `orchard-finding` / `orchard-outcome` / `orchard-ask` / `orchard-judgment` / `orchard-status` / `orchard-narration` — plus a first-class `orchard-uncategorized <label>` whose label the metrics cluster so the fallback firing NAMES the missing category. Presentation derives from the category (exactly one folds, so the hiding surface did not widen); `orchard-answer`/`orchard-notes` are frozen legacy names and archived transcripts render unchanged. Suites EXTENDED not replaced: the enumerated corpus is graded twice, under both name families (42,564 cases), renderer 201/0 in a real browser, differential 23/0. See the ROUND 12 entry at the foot. | med |
| BUG-111 | Tilde-fenced code blocks render as live headings and tables | — | IN-VERIFICATION Hold this until the block grammar it must match stops changing, then rewrite the shared renderer's fence handling to follow that grammar. If we wait: Fenced content renders as live markup instead of code wherever tildes or nesting appear. Bounded: the content stays visible rather than being swallowed, and no stored text is altered. | med |
| BUG-113 | Background work is reported as dead while it is still running | — | OPEN Teach the turn-end sweep the same live-versus-dead distinction the server already makes, then prove strip, card and ledger agree. If we wait: A person sees a card marked cut and reasonably believes their agent died, so they may redo or abandon live work. Bounded: display-correctness only. The agent keeps running, nothing is cancelled, and no stored data is affected. | med |
| BUG-114 | Verification runs leave live sessions behind with no owner | — | IN-VERIFICATION Independent clean-room pass on the new orphan-bound suite before it is trusted as the regression gate; the bound itself is proven live, twice. If we wait: Every verification run adds long-lived processes nobody owns, and one blunt cleanup command could take the user's live session with it. Bounded: the running service and stored data are unaffected today, and the leaked processes are idle load rather than corruption. | high |
| BUG-115 | An overnight machine suspend recorded a passing suite as failed | 👤 | OPEN — NEEDS A HUMAN DECISION (2 options). Recommended: A — It removes a false verdict from the one class of result this project most needs to trust, and it can be added without touching any product path. If we wait: A suite that was green can be posted as red, and a person or a gate may act on a result that never happened. Bounded: it needs an actual suspend during a run, no data is lost, and the leaked-process side already has its own ticket. | high |
| BUG-116 | Enabling the stealth browser opened a window for every session | 👤 | IN-PROGRESS — NEEDS A HUMAN DECISION (3 options). Recommended: A — It removes the cause rather than working around it, and is small enough to revert on its own if the new startup order misbehaves. If we wait: Container-isolated projects keep opening an unused logged-in browser per project, costing memory and leaving a visible window. Bounded: sessions that use the browser work correctly either way, no user data is lost, and the daemon's idle timeout still reclaims it. | med |
| BUG-117 | A stray test server can shut down the live session | — | IN-VERIFICATION Independent clean-room pass on the ownership gate: the fix is live and covered by a checked-in suite, but a bypass was found only by tripping it against the live session, so generation must not be its own last verifier. If we wait: The next test run that mistypes, drops, or inherits the wrong isolation setting ends the user's live session with no warning. Bounded: the session drains rather than being cut off, transcripts stay intact, and every checked-in test script spells the setting correctly today. | high |
| BUG-120 | Independent verifiers can read the plans they are meant to check | — | OPEN Build the inversion here: the clean room receives only what a check names as an input, and each verdict records what it was given. If we wait: Independent verdicts are weaker than they appear, because a checker can grade work against the same expectations that produced it. Bounded: this is passive exposure, with no evidence that any past checker read those files or that any past verdict is wrong. | med |
| BUG-121 | Tickets with a record block below the top read as never migrated | 👤 | OPEN — NEEDS A HUMAN DECISION (2 options). If we wait: A reader is told a migrated ticket is unmigrated and shown a state pulled from elsewhere. Bounded: this is display-correctness only. The file on disk is untouched, and the record still renders as a plain code block in the body. | med |
| FEAT-093 | Supporting detail buried the parts of a reply addressed to the reader | — | IN-PROGRESS — awaiting your review If we wait: Readers keep scrolling past supporting detail to reach what is addressed to them. Bounded: this is display only. No reply content is lost, folded text stays one click away, and the other categories are untouched. | low |
| BUG-133 | Promoting a few tickets erases the archive record of the rest | — | OPEN Keep the entries already in the archive index and merge the new ones in, rather than rewriting the file from the current run alone. If we wait: The next promotion of a small batch destroys the provenance record for every ticket archived before it, silently. Bounded: the archived originals themselves are untouched and the index is recoverable from version control, but only if someone reads the change before committing it. | med |
| ARCH-008 | Ticket readers disagree about the same file | — | OPEN Build option A in the order the migration section already sets out: move partial-write diagnosis into the portable source first, then serve the parsed record and delete the browser grammar. If we wait: The disagreement is latent across 0 of 193 tickets today but reaches every migrated ticket after rollout. Bounded: this affects display-correctness in a single-user local tool, not ticket data, and nothing is destroyed. | high |
| ARCH-007 | Browser startup remains eager in container sessions | 👤 | IN-VERIFICATION — awaiting your review If we wait: Container sessions remain eager, and every browser call retains station-owned protocol code in its request path. Bounded: this is a single-user local tool with nothing deployed; no user data is at risk, and no lost reply has been reported. | med |
| FEAT-096 | nobody could say which tools the orchestrator actually needs | 🤖 | IN-VERIFICATION — enforcement is now ENABLED on all 13 registry projects and verified per project (197/197 config, 12/13 in real sessions, containers included). Takes effect at the service's next restart: the running server predates the code. A live-session escape (`node -e`) was found and closed. Independent clean-room pass still required. | low |
| ARCH-011 | Whoever does the work also chooses the check that passes it | 🤖 | IN-PROGRESS Land the measured-staleness retry rule the user chose: hash a lane's touched set at its end, and route the retry on whether those bytes still match. If we wait: The reasoning is a day old and lives in four documents nobody will re-read. The same two designs then get proposed again, and the same flaw re-found. Bounded: no product behaviour is affected and no work is blocked, because both replacement pieces are moving already. | med |
| ARCH-010 | Each reader works out facts their owner never states | 🤖 | IN-PROGRESS Build work on the three instances the class rule now answers: which project a view shows, who owns canonical text, and who owns the record grammar. If we wait: A new instance appears in a new subsystem roughly every three days, each arriving as its own architecture ticket needing its own answer. Bounded: this affects display correctness and internal record-keeping in a local single-user tool. No user data is at risk and every surface keeps working. | high |
| FEAT-098 | Replies read as stories because blocks shape prose only from outside | — | IN-PROGRESS — awaiting your review If we wait: Every substantive reply on every project keeps costing the reader a paragraph parse per fact. Bounded: this is guidance inside a block, so nothing about the grammar, the parser, the fold or archived transcripts changes, and a reply written the old way still renders exactly as before. | med |
| FEAT-099 | Everyday git work still means leaving Orchard | 🤖 | IN-PROGRESS Nothing outstanding. An independent clean-room verify pass is warranted before this is called closed. If we wait: Nothing breaks and nothing shipped regresses. The cost of waiting is only that the reasoning goes cold, which is why it is recorded here rather than built. The user marked it optional and future, so this is a parked idea, not queued work. | low |
| FEAT-100 | A dispatch does not declare its ticket, phase, round or class | — | IN-PROGRESS none - the capture and the report are built and verified; what remains is dispatchers actually writing the line. If we wait: The per-ticket finding/fixing/verifying breakdown that was asked for cannot be produced. Bounded: nothing breaks while this waits, but each passing window is one whose phase split is unrecoverable, because the facts were only knowable at dispatch time. | med |
| BUG-136 | a containerised session says Error and never answers | — | OPEN — awaiting your review If we wait: Every container project dies silently one token rotation after its container was created, and stays dead: nothing recreates the container and the badge names nothing. The guard written for this exact message checks that the HOST file exists, which it always does. | high |
| FEAT-102 | A containerised session cannot reach openai, and is told to try anyway | — | IN-VERIFICATION One independent clean-room round, scoped to cross-project isolation: can one project container reach another project broker or tree, and does the protocol hold on partial frames and peer death. Everything else on this ticket is proven. If we wait: Every containerised project is Claude-only in practice while being instructed at launch to use a cross-provider capability it does not have, so cross-provider verification (FEAT-060/FEAT-061) is unavailable exactly where isolation matters most, and each session burns a round discovering the gap for itself. | high |
| ARCH-012 | A rotating secret mounted as a single file goes stale invisibly | — | OPEN decide If we wait: A real project was silently logged out for two days and took three rounds to diagnose, because every natural check reports health. Any future capability that mounts a second rotating secret as a single file inherits the same silent, delayed, inspection-proof failure. | med |
| BUG-140 | Agents waiting on work that already ended still look busy | 👤 | OPEN — NEEDS A HUMAN DECISION (4 options). If we wait: One such wait is still sleeping now, more than forty minutes after the run it watched ended, and nothing will ever end it. Bounded: no result is falsified and no stored data is touched. The cost is a person's attention and the minutes spent proving the work is dead. | med |
| BUG-142 | Git history stops at the first page: Load more adds nothing | — | OPEN Find what happens between the click and the render — the server half is already proven correct — then re-run npm run verify:git to completion. If we wait: Anything older than the 50th commit is unreachable from the History view, and two suites (verify:git, and FEAT-099 that depends on it) cannot finish, so their later checks are unproven rather than passing. | med |
| BUG-143 | Injected block-format instructions are 31 percent over their budget | — | OPEN Either bring the section back inside 4000 characters or restate the budget with the reason it moved — and say which, on the ticket that changed it. If we wait: Each session carries about 1,200 characters of extra instruction it was not budgeted, paid on every launch, and a red check in the grammar suite that everyone learns to read past. | low |
| BUG-146 | the injected local-conventions doc is silently truncated to a fifth | — | OPEN Decide whether the cap rises, whether the doc gets an inject-marked region like ROUTING.md and RESPONSE_FORMAT.md, or whether truncation becomes loud. If we wait: Project rules are written, committed, believed to be in force, and never delivered. The testing conventions, the rg-not-grep rule and the separate-process verification rule are all past the cut today, and an author has no way to notice. | med |
| BUG-147 | strict MCP config silently drops the user's own MCP servers | — | OPEN Document the suppression where a user reads it, and surface the attached MCP set in the UI so the default is visible rather than inferred. If we wait: The user concludes MCP does not work in Orchard and re-configures by hand, or gives up. The one server that IS on by default is invisible unless they inspect the launch argv, so the surface looks empty from outside. | med |
| FEAT-104 | the private project names the leak gate could not see | — | OPEN Alias the remaining names in the style the earlier scrub used, add the class to the gate token list so it cannot go invisible again, and hoist the .arch ignore rule into the root .gitignore. If we wait: The names ship the first time this repo is published, and the gate reports PASS while they do — the failure mode is a green check over a leak. | high |
| BUG-148 | agents commit under the account email, not the repo identity | — | OPEN State the rule where agents read it: a commit to a real repo never carries an identity on its command line. Then decide whether the command guard should refuse the pattern mechanically. If we wait: It keeps recurring — the most recent instance is 2026-08-25, days after global config was corrected — and each one is a metadata field no ordinary commit can fix afterwards. | med |
| BUG-150 | Messages queued before a session's transcript loads are not stored | — | OPEN confirm the window is reachable by a person (not only by a script), then close it If we wait: A message typed in the moment right after opening a session is silently non-durable. It looks queued and is not stored, so a reload or a tab close destroys it with no signal, which is the failure class the board treats as the worst this product has. | med |
| ARCH-013 | Every project must run adversarial rounds; only one has the tool | 👤 | OPEN — NEEDS A HUMAN DECISION (4 options). No build starts until an option is chosen. Recommended: C — The scoping fix already removes most rounds, so what remains is whether the survivors are real. C refuses an unnameable round where the spend happens, in a file that already records class and round. If we wait: Every non-orchard project keeps paying clean-room prices for a round that cannot be a round. The expensive half is already closed by the shipped harm-class table, so what remains is duplication, not risk. No product behaviour is affected and no data is exposed. | med |
| FEAT-105 | No way to close the browser, so a session improvises a kill | — | IN-VERIFICATION — awaiting your review If we wait: Every browser-using session leaves a real headful window in the user's workspace for up to 15 idle minutes, each one an invitation to improvise a kill against a process the session cannot identify. Bounded: no user browser killed yet; observed damage is nuisance windows. | high |
| BUG-151 | A UI check used the headful browser; the headless one was broken | — | IN-VERIFICATION — awaiting your review If we wait: Every container project with Playwright enabled lists ~24 browser tools that all fail on first navigate. Three are in that state today. The user never sees the error — only a silent downgrade to the headful browser, so ordinary UI checks keep interrupting them. | high |
| ARCH-014 | a named capability is never confronted with its runtime | — | OPEN A decision on which of the four options to take, or to accept D deliberately. Nothing is broken right now; this exists so the fourth instance is recognised as a recurrence instead of a novelty. If we wait: Each instance shipped something that looked like a capability and was not, and each was caught by accident rather than by a check. The pipeline that let them through is unchanged, so a fourth is no less likely — and may not be caught before someone relies on it. | med |
| BUG-152 | a session refuses to start when an optional browser is unconfigured | — | IN-PROGRESS A session in the affected project answers a message. If we wait: Every browser-enabled project stays dead after any reboot, with an error naming an environment variable rather than anything the user set. The same class recurs: host configuration outside the repo can take sessions down for reasons unrelated to the session. | high |
| BUG-153 | the status chip and the send guard disagreed about liveness | — | IN-PROGRESS The status a user reads and the guard that refuses their send must come from one predicate, and a queued message in a tab that cannot deliver it must be recoverable in one action. If we wait: Every restart, refused takeover and reload can leave a tab that lies about what is running and refuses the action it just invited. The user's typed message is what is at risk each time, and the lie is paid for in retyping. | high |
| BUG-154 | Socket dialog says the access is permanent, when the damage is | — | IN-VERIFICATION — awaiting your review If we wait: The one control that hands a session root on this machine is the one the user cannot parse. Some will refuse a reversible setting; worse, some will decide the warning is loose and discount the part of it that is true. | med |
| BUG-155 | A valid orchard-digest fence renders as JSON when a lead-in precedes it | — | OPEN A design call: the contract says the digest must lead. Decide between lifting a well-formed digest fence even behind a short lead-in, and the contract-preserving floor: an un-lifted digest block must never render its raw JSON as prose. If we wait: Across all local transcripts: 556 messages carry a digest, 18 (3.2%) fail this exact way, every one a well-formed fence preceded by a lead-in. NOT the quoted/unfenced JSON originally hypothesised (0 found). It looks benign to the author, so it recurs silently across projects. | med |
| FEAT-106 | Consolidate Orchard's generated files into a project-local .orchard directory | — | OPEN Land the layout-independent foundation first (board-path resolver + inert layout-independence fixes) so the onboard rewrite and consumer cutover can follow without moving Orchard's own board. If we wait: Every onboarded Next.js target keeps risking publishing Orchard dashboard internals (dom.js, digest.js, route.js, response-blocks.js) at public URLs, and the generated files stay scattered and easy to miss when reasoning about a target repo. | med |

FE = frontend (app.js / drawer.js), serialized with each other. SV = server.

## Done (committed)

| ID | Title | Commit |
|----|-------|--------|
| BUG-004 | Reloading replaced live conversation with an old agent summary | f4fc2a3 |
| BUG-007 | Restoring the oldest snapshot silently deleted it | b0e5f8f |
| BUG-008 | Reattached sessions hid requests blocking the active turn | 8a1306e |
| FEAT-016 | Streaming replies showed raw markup until the turn ended | 3039e76 |
| BUG-006 | New sessions inherited earlier session settings | d6b9ad3 |
| BUG-010 | Session settings hid edits and changed the next session | 539d252 |
| BUG-009 | Project-wide session browsing was unreachable from Finder | d4a8062 |
| BUG-011 | Session switches carried the previous thread into navigation | 110e7f9 |
| BUG-014 | Old sub-agent summaries appeared inside a running conversation | 2850d5b |
| BUG-001 | Skip-permissions resets for followed sessions | dadf84c |
| FEAT-002 | Queued messages read as replies to answers they never saw | a32d9f5 |
| BUG-015 | Armed override chip showed inconsistent timing text | 4add097 |
| BUG-013 | Budget-stopped sessions showed rejected messages as delivered | e752ad6 |
| BUG-012 | Malformed search links returned an internal server error | d675bad |
| DEPLOY-003 | Committed server fixes were not running on the live service | (done) |
| FEAT-018 | Decisions raised in chat were easy to miss and hard to track | 102aa5d |
| FEAT-021 | Fresh sessions started without knowing the project's current state | 3c6d57d |
| FEAT-028 | The station required a terminal window left open to keep running | cf95209 |
| FEAT-027 | Edited working agreements did not reach new sessions | 0a5bc11 |
| FEAT-029 | Live sessions could not raise a decision for the user to answer | a007308 |
| FEAT-020 | Every project rebuilt the same agent orchestration from scratch | (umbrella) |
| BUG-016 | Resolved decisions lingered in the Needs-You rail | (this) |
| BUG-017 | Live reload replaces conversation with agent summary | (this) |
| BUG-018 | Session navigation now preserves pending approvals and running work | (this) |
| BUG-020 | Reloaded dashboards lost completed sub-agent activity | (this) |
| FEAT-032 | Bugs were found by the user instead of by our own process | (this) |
| FEAT-031 | Queued messages waited for a boundary and lost their timing | (this) |
| BUG-021 | Inherited sessions hid the model they would use | (this) |
| FEAT-035 | Dashboard had no visual identity after the product rename | (this) |
| FEAT-034 | Settings list showed options that did not apply | (this) |
| FEAT-015 | Sessions died whenever the server was restarted | (this) |
| BUG-022 | Immediate reconnects no longer corrupt a surviving session | (this) |
| BUG-024 | Sessions survive service restarts despite misleading diagnostics | (this) |
| FEAT-024 | Projects rebuild the same dispatch shapes from scratch | (this) |
| FEAT-040 | Sessions gave no sign they were reconnecting or running in the background | (this) |
| BUG-023 | Closed sessions left metadata files on disk | (this) |
| FEAT-039 | Project rules could drift apart across separate projects | (this) |
| BUG-025 | User-owned tickets showed response boxes without questions | (this) |
| FEAT-025 | Dispatched agents had no symbol-aware code tools | (this) |
| FEAT-041 | Working Agreement had no home outside this project | (this) |
| FEAT-019 | Standing rules faded from a doc that also grew contradictory | (this) |
| FEAT-022 | Long unattended runs stopped for confirmation at every step | autonomous + bounded stop + auto-continue loop + Stop (safe subset) |
| BUG-026 | Choosing a different model left the session on the old one | (this) |
| FEAT-038 | Bringing the orchestrator to a new repo took manual setup | (this) |
| BUG-027 | Surviving sessions disappeared from restart health reports | (this) |
| BUG-029 | Refused resume discarded the typed message | (this) |
| BUG-028 | Restart interruptions now show the correct cause | (this) |
| FEAT-042 | Session model changes were invisible until someone checked | (this) |
| BUG-030 | Finished agent calls no longer remain visibly active | (this) |
| BUG-031 | Provider failures could leave sessions visibly stuck | (this) |
| FEAT-037 | Orchard can now run sessions on a second provider | (this) |
| FEAT-043 | Sessions can now run agents on either provider by strength | (this) |
| FEAT-044 | First outside project brought onto the shared orchestrator stack | (this) |
| BUG-032 | Mouse wheel could not scroll the sidebar | (this) |
| FEAT-045 | Sessions could not be started on the other engine | (this) |
| FEAT-047 | Consolidation findings that need a person stayed invisible | (this) |
| FEAT-048 | Dashboard never showed whether a session survives a restart | (this) |
| FEAT-050 | Automated pushes could ship changes nobody independently reviewed | (this) |
| FEAT-052 | Public repository had no readable introduction or screenshots | (this) |
| FEAT-046 | Shipped features were hard to find where people need them | (this) |
| BUG-035 | Serena was missing from onboarded project sessions | (this) |
| BUG-033 | Sessions appeared active while messages remained undelivered | (this) |
| FEAT-056 | Repeated fixes in one area never triggered a design review | (this) |
| FEAT-026 | Every session carried a long instruction preamble by default | (decision) |
| FEAT-036 | Project keeps its old internal name while the product is rebranded | (decision) |
| FEAT-017 | Working practices died with the session that invented them | (umbrella done) |
| FEAT-005 | Ticket discipline stayed a manual convention for one project | (superseded by FEAT-017) |
| BUG-019 | Normal reloads were not serving outdated assets | (not-a-bug) |
| BUG-038 | Refused messages left the composer appearing unresponsive | (uncommitted) |
| BUG-036 | The anti-regression check crashed before running anything | (uncommitted) |
| BUG-039 | Findings checks no longer depend on run order | (uncommitted) |
| BUG-034 | Main session work now appears in the agents strip | (uncommitted) |
| FEAT-057 | Agents that stopped were invisible until someone sent a message | (uncommitted) |
| FEAT-059 | Global new-session button opened a session in the selected project | (uncommitted) |
| FEAT-060 | Agents executed the orchestrator's reading instead of testing it | (uncommitted) |
| BUG-042 | Universal rules were silently removed from shared instructions | (uncommitted) |
| FEAT-051 | Attached integrations were invisible in the session topbar | (uncommitted) |
| FEAT-053 | Rail sections could grow until one crowded out the rest | (uncommitted) |
| FEAT-054 | Status chips opened settings without landing on their section | (uncommitted) |
| FEAT-063 | The ticket portal looked like a chat instead of a tracker | (uncommitted) |
| BUG-045 | Retryable messages now queue during restart draining | (uncommitted) |
| BUG-044 | Server restarts terminated live background work | (uncommitted) |
| BUG-040 | Scratch server boots changed the project’s architecture findings | (uncommitted) |
| BUG-041 | Agent deaths showed an unrelated failure reason | (uncommitted) |
| BUG-046 | Stalled background work now surfaces visibly | (uncommitted) |
| BUG-047 | Cleanup checks failed on an unchanged codebase | (uncommitted) |
| FEAT-064 | Restart refusal did not say what was holding the session | (uncommitted) |
| FEAT-065 | Messages sent after a restart waited for background work to finish | (uncommitted) |
| BUG-066 | Correct verification runs were rejected as stand-ins | (uncommitted) |
| FEAT-062 | Repeated verification rounds threw away the fixer's context | f6b17b2 |
| BUG-043 | Closing a session killed its background work | 26014ba |
| BUG-067 | Harness notices appeared as messages sent by the user | 0eddc88 |
| FEAT-055 | First turn of a session ran without its project tools | 4f9e8ff |
| FEAT-058 | Tickets could only be browsed through the live session panel | 0ddedb8 |
| FEAT-061 | Fix agents graded their own work with the same blind spots | (uncommitted) |
| BUG-073 | Conflict markers survived ticket board regeneration | (uncommitted) |
| BUG-037 | Background work was falsely reported as dead | c80b152 |
| BUG-072 | Active delivery sessions disappear from status views | (uncommitted) |
| BUG-074 | Finished background work trapped queued messages | (uncommitted) |
| BUG-069 | Oversized fixer relay check failed intermittently | (uncommitted) |
| BUG-071 | Recently closed tickets could bypass the verification warning | (uncommitted) |
| FEAT-066 | Ticket board could not be opened from the interface | (uncommitted) |
| BUG-080 | Public mirror exposed private screenshot data | (uncommitted) |
| BUG-079 | Messages crossed sessions or disappeared | (uncommitted) |
| BUG-075 | Direct sessions showed a container-only mount control | (uncommitted) |
| BUG-081 | Model-change notices blended into ordinary conversation | (uncommitted) |
| FEAT-067 | Orchestrator status scrolled away in chat instead of staying glanceable | (uncommitted) |
| ARCH-001 | Liveness decisions now share one server authority | phases 1–2 (incl. BUG-034, FEAT-057) |
| ARCH-002 | Background work was ended while still running | decision + BUG-044, FEAT-062 |
| BUG-068 | Background shell work was missing from the running display | aabf45e |
| BUG-070 | Old outcomes appeared current and crowded out new events | 660fd87 |
| BUG-076 | Websites could control local sessions without permission | 9412773 |
| BUG-077 | Idle stops mislabel the next turn as interrupted | 5d91269 |
| BUG-078 | Streamed text was silently corrupted at chunk boundaries | 65a2a55 |
| FEAT-068 | Completed tickets stayed in the open list indefinitely | (uncommitted) |
| BUG-082 | Long port lists crowd out topbar controls | (uncommitted) |
| FEAT-069 | Long picker lists could not be narrowed by typing | (uncommitted) |
| BUG-083 | Project switches mixed drafts and running agents | (uncommitted) |
| BUG-084 | Chosen model repeatedly appears as an unrequested change | (uncommitted) |
| FEAT-070 | Sidebar buried recent work under stale projects and sessions | (uncommitted) |
| BUG-085 | Recent sessions overflow the collapsed sidebar limit | (uncommitted) |
| FEAT-071 | Nothing in the interface showed which directory a project used | (uncommitted) |
| FEAT-072 | Queued message boilerplate ran straight into the user's words | (uncommitted) |
| BUG-087 | Opened sessions showed the previous session’s transcript | (uncommitted) |
| FEAT-074 | Adding a project landed on an old session and hid it | (uncommitted) |
| FEAT-075 | New users could not learn what runs behind the scenes | (uncommitted) |
| BUG-088 | Tool settings changes failed to persist | (uncommitted) |
| BUG-089 | Partial settings saves falsely report failure | (uncommitted) |
| FEAT-076 | No way to see whether a project uses our methodology | (uncommitted) |
| FEAT-077 | Templates list read as a wall of jargon | (uncommitted) |
| BUG-090 | Older sessions showed internal errors after enabling containers | 48c64ec |
| BUG-091 | MCP servers failed after cold service starts | (uncommitted) |
| FEAT-079 | Standing findings crowded the rail meant for decisions | (uncommitted) |
| FEAT-080 | Nobody could learn the system's design without reading the code | (uncommitted) |
| BUG-094 | Back links opened a blank session | (uncommitted) |
| FEAT-083 | Long agent replies were unscannable walls of prose | (uncommitted) |
| FEAT-084 | Sessions were never told to produce the structured reply format | (uncommitted) |
| BUG-095 | Digest items were visually difficult to distinguish | (uncommitted) |
| BUG-093 | Product names no longer create false recurrence clusters | (uncommitted) |
| FEAT-081 | Guide pages showed tables and links as raw text | (uncommitted) |
| BUG-092 | Cross-provider checks returned invalid results | (uncommitted) |
| BUG-097 | Verifier formatting errors discarded completed verification work | (uncommitted) |
| FEAT-085 | Overlong replies persisted despite standing instructions | (uncommitted) |
| BUG-099 | Working Agreement attachment omitted its required base | (uncommitted) |
| BUG-100 | Running work replaced the footer’s stable access label | (uncommitted) |
| BUG-098 | Digest chip and label text were hard to read in light theme | (uncommitted) |
| BUG-101 | Muted text failed accessibility contrast across the app | (uncommitted) |
| BUG-102 | Safety checks could fail while commits continued | (uncommitted) |
| FEAT-089 | Projects added to Orchard started without the working method | (uncommitted) |
| BUG-086 | Pinned sessions look like the open session | (uncommitted) |
| BUG-096 | Background work was reported dead while still running | (uncommitted) |
| FEAT-073 | New sessions were invisible in the sidebar until first message | (uncommitted) |
| FEAT-078 | Sessions started outside Orchard were missing for one provider | (uncommitted) |
| BUG-103 | Searching the largest source file returned nothing and looked like no matches | (uncommitted) |
| BUG-105 | Live background work was recorded as dead at turn end | (uncommitted) |
| BUG-106 | Live agents from one project showed under another project | (uncommitted) |
| BUG-107 | Container projects silently lost their code-navigation tools for two weeks | (uncommitted) |
| BUG-109 | Part of a rendered message vanished with no error | (uncommitted) |
| BUG-110 | Tables silently dropped a cell from an over-wide row | (uncommitted) |
| BUG-112 | A verification sandbox could write into the live repository | 43e6065 |
| ARCH-003 | Background work is misreported after a turn ends | (uncommitted) |
| ARCH-009 | Ticket proof status could be silently misclassified | 568d8da |
| BUG-119 | Finished tickets migrated to a record denying any proof existed | 568d8da |
| BUG-122 | The board named a ticket after its opening code fence | 568d8da |
| BUG-123 | Regenerating the board erased a waiting decision from its row | efc927b |
| BUG-124 | Board checks went red when tickets were used correctly | 39c60c7 |
| BUG-125 | a verification verdict written on a second line is recorded as no verdict at all | 5a64311 |
| BUG-130 | The dock promised one-per-turn delivery the queue had already stopped doing | (uncommitted) |
| BUG-131 | only ARCH type labels were coloured | 3736dda |
| BUG-118 | A reply-format advisory appeared in unrelated projects | 9163d21 |
| BUG-132 | the drain retry typed over the user, every seven seconds | 09db10f |
| BUG-134 | the queue chip reported the broker's lifetime as the user's wait | e9efb92 |
| BUG-135 | a tool enabled mid-session vanishes from the UI instead of pending | (uncommitted) |
| BUG-137 | the pinned row shouted instead of being scannable | (uncommitted) |
| BUG-138 | a session in a renamed project directory says Error and answers nothing | (uncommitted) |
| BUG-141 | Codex session messages are absent from search | (uncommitted) |
| BUG-126 | One ticket's severity swallowed a sentence and broke its row | (uncommitted) |
| BUG-127 | One ticket's wording can erase rows from the archive index | (uncommitted) |
| BUG-128 | A ticket listed itself among its own related tickets | (uncommitted) |
| FEAT-094 | The cutover could not proceed while two tickets stayed contested | (uncommitted) |
| FEAT-095 | A request already on the board gets worked a second time | (uncommitted) |
| FEAT-101 | Dashboard panels slide in from the right | (uncommitted) |
| BUG-139 | git crown chip renders undefined line counts from stale status payloads | (uncommitted) |
| FEAT-103 | nav search reads titles-only: content search is a hidden Enter-only mode | (uncommitted) |
| BUG-129 | A message typed while the assistant is working is silently lost | (uncommitted) |
| FEAT-097 | Every board change went through a hand-written index edit | (uncommitted) |
| BUG-145 | the WA states the no-inline-work rule as a slogan with no threshold | (uncommitted) |
| BUG-144 | projects added before the auto-attach never got the Working Agreement | (uncommitted) |
| BUG-149 | A message refused as live-in-another-tab is lost, silently | (uncommitted) |

## Shipped earlier (pre-tracker)
Routing, search, recency, memories, OOM, git, sidebar attention, diff chips,
add-project UX, slash palette, `/model` picker, layout passes, settings cards,
favicon/titles, queue v2 + combined delivery, detach/reattach, reload-live,
agent-summary suppression, sidebar cap.
